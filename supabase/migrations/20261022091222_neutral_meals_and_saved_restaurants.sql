ALTER TABLE public.meals
  ADD COLUMN is_neutral boolean NOT NULL DEFAULT false,
  ALTER COLUMN creator_member_id DROP NOT NULL;

ALTER TABLE public.meals
  ADD CONSTRAINT meals_neutral_creator_check
  CHECK (
    (is_neutral AND creator_member_id IS NULL)
    OR (NOT is_neutral AND creator_member_id IS NOT NULL)
  );

CREATE TABLE public.saved_restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  restaurant_name text NOT NULL CHECK (char_length(trim(restaurant_name)) > 0),
  place text NOT NULL CHECK (char_length(trim(place)) > 0),
  maps_url text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  shared_at timestamptz
);

CREATE INDEX saved_restaurants_member_created_idx
  ON public.saved_restaurants (member_id, created_at DESC);

ALTER TABLE public.saved_restaurants ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_restaurants TO authenticated;

DROP POLICY IF EXISTS meals_create_waiting_group_account ON public.meals;

CREATE POLICY meals_create_waiting_group_account
  ON public.meals
  FOR INSERT
  TO authenticated
  WITH CHECK (
    private.is_group_account()
    AND status = 'waiting'
    AND started_at IS NULL
    AND completed_at IS NULL
    AND (
      (is_neutral AND creator_member_id IS NULL)
      OR (
        NOT is_neutral
        AND creator_member_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.members
          WHERE id = creator_member_id AND is_active
        )
      )
    )
  );

CREATE POLICY saved_restaurants_group_access
  ON public.saved_restaurants
  FOR ALL
  TO authenticated
  USING (private.is_group_account())
  WITH CHECK (private.is_group_account());

CREATE OR REPLACE FUNCTION public.start_neutral_meal(
  p_meal_id uuid,
  p_actor_member_id uuid,
  p_participant_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  neutral_meal boolean;
  participant_count integer;
BEGIN
  IF NOT private.is_group_account() THEN
    RAISE EXCEPTION 'Only group members may start a meal.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.members
    WHERE id = p_actor_member_id AND is_active
  ) THEN
    RAISE EXCEPTION 'The selected member is not active.';
  END IF;

  IF p_participant_ids IS NULL OR cardinality(p_participant_ids) = 0 THEN
    RAISE EXCEPTION 'Select at least one participant.';
  END IF;

  SELECT count(DISTINCT selected.member_id)
    INTO participant_count
    FROM unnest(p_participant_ids) AS selected(member_id);

  IF participant_count <> cardinality(p_participant_ids) THEN
    RAISE EXCEPTION 'Participant list contains duplicates.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_participant_ids) AS selected(member_id)
    LEFT JOIN public.members AS member ON member.id = selected.member_id
    WHERE member.id IS NULL OR NOT member.is_active
  ) THEN
    RAISE EXCEPTION 'All participants must be active members.';
  END IF;

  SELECT is_neutral
    INTO neutral_meal
    FROM public.meals
    WHERE id = p_meal_id
    FOR UPDATE;

  IF NOT FOUND OR NOT neutral_meal THEN
    RAISE EXCEPTION 'Neutral meal was not found.';
  END IF;

  IF (SELECT status FROM public.meals WHERE id = p_meal_id) <> 'waiting' THEN
    RAISE EXCEPTION 'Only a waiting meal may be started.';
  END IF;

  INSERT INTO public.meal_participants (meal_id, member_id, selected_at)
  SELECT p_meal_id, selected.member_id, now()
  FROM unnest(p_participant_ids) AS selected(member_id);

  UPDATE public.meals
  SET status = 'running', started_at = now()
  WHERE id = p_meal_id;
END;
$$;

REVOKE ALL ON FUNCTION public.start_neutral_meal(uuid, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_neutral_meal(uuid, uuid, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.share_saved_restaurant(
  p_saved_restaurant_id uuid,
  p_member_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  saved public.saved_restaurants%ROWTYPE;
  created_meal_id uuid;
BEGIN
  IF NOT private.is_group_account() THEN
    RAISE EXCEPTION 'Only group members may share a saved restaurant.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.members
    WHERE id = p_member_id AND is_active
  ) THEN
    RAISE EXCEPTION 'The selected member is not active.';
  END IF;

  SELECT *
    INTO saved
    FROM public.saved_restaurants
    WHERE id = p_saved_restaurant_id AND member_id = p_member_id
    FOR UPDATE;

  IF NOT FOUND OR saved.shared_at IS NOT NULL THEN
    RAISE EXCEPTION 'Saved restaurant was not found or was already shared.';
  END IF;

  INSERT INTO public.meals (
    restaurant_name,
    place,
    maps_url,
    note,
    creator_member_id,
    is_neutral,
    status
  )
  VALUES (
    saved.restaurant_name,
    saved.place,
    saved.maps_url,
    saved.note,
    p_member_id,
    false,
    'waiting'
  )
  RETURNING id INTO created_meal_id;

  UPDATE public.saved_restaurants
  SET shared_at = now()
  WHERE id = saved.id;

  RETURN created_meal_id;
END;
$$;

REVOKE ALL ON FUNCTION public.share_saved_restaurant(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.share_saved_restaurant(uuid, uuid) TO authenticated;
