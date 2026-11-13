-- Fressung entscheiden: Vorschläge aus der Merkliste, Abstimmung oder Zufall.

ALTER TABLE public.saved_restaurants
  ADD COLUMN proposed_at timestamptz;

CREATE INDEX saved_restaurants_proposed_idx
  ON public.saved_restaurants (proposed_at)
  WHERE proposed_at IS NOT NULL AND shared_at IS NULL;

CREATE TABLE public.decision_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'voting' CHECK (status IN ('voting', 'closed', 'cancelled')),
  started_by_member_id uuid NOT NULL REFERENCES public.members(id),
  winning_meal_id uuid REFERENCES public.meals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

-- Es darf immer nur eine laufende Abstimmung geben.
CREATE UNIQUE INDEX decision_rounds_single_voting_idx
  ON public.decision_rounds ((true)) WHERE status = 'voting';

CREATE TABLE public.decision_votes (
  round_id uuid NOT NULL REFERENCES public.decision_rounds(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  saved_restaurant_id uuid NOT NULL REFERENCES public.saved_restaurants(id) ON DELETE CASCADE,
  voted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, member_id)
);

ALTER TABLE public.decision_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decision_votes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.decision_rounds, public.decision_votes TO authenticated;

CREATE POLICY decision_rounds_group_read ON public.decision_rounds
  FOR SELECT TO authenticated USING (private.is_group_account());
CREATE POLICY decision_votes_group_read ON public.decision_votes
  FOR SELECT TO authenticated USING (private.is_group_account());

-- Legt aus einem Vorschlag eine normale ausstehende Fressung an und leert die Vorschlagsliste.
CREATE FUNCTION private.create_meal_from_proposal(p_saved_restaurant_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  saved public.saved_restaurants%ROWTYPE;
  created_meal_id uuid;
BEGIN
  SELECT * INTO saved
    FROM public.saved_restaurants
    WHERE id = p_saved_restaurant_id AND proposed_at IS NOT NULL AND shared_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proposal was not found.';
  END IF;

  INSERT INTO public.meals (restaurant_name, place, maps_url, note, creator_member_id, is_neutral, status)
  VALUES (saved.restaurant_name, saved.place, saved.maps_url, saved.note, saved.member_id, false, 'waiting')
  RETURNING id INTO created_meal_id;

  UPDATE public.saved_restaurants SET shared_at = now(), proposed_at = NULL WHERE id = saved.id;
  UPDATE public.saved_restaurants SET proposed_at = NULL WHERE proposed_at IS NOT NULL;
  RETURN created_meal_id;
END;
$$;
REVOKE ALL ON FUNCTION private.create_meal_from_proposal(uuid) FROM PUBLIC;

CREATE FUNCTION private.assert_active_group_member(p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.is_group_account() THEN
    RAISE EXCEPTION 'Only group members may decide a meal.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.members WHERE id = p_member_id AND is_active) THEN
    RAISE EXCEPTION 'The selected member is not active.';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.assert_active_group_member(uuid) FROM PUBLIC;

CREATE FUNCTION public.start_decision_vote(p_member_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  round_id uuid;
BEGIN
  PERFORM private.assert_active_group_member(p_member_id);
  IF (SELECT count(*) FROM public.saved_restaurants
      WHERE proposed_at IS NOT NULL AND shared_at IS NULL) < 2 THEN
    RAISE EXCEPTION 'At least two proposals are needed for a vote.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.decision_rounds WHERE status = 'voting') THEN
    RAISE EXCEPTION 'A vote is already running.';
  END IF;
  INSERT INTO public.decision_rounds (started_by_member_id) VALUES (p_member_id)
    RETURNING id INTO round_id;
  RETURN round_id;
END;
$$;

CREATE FUNCTION public.cast_decision_vote(p_round_id uuid, p_member_id uuid, p_saved_restaurant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM private.assert_active_group_member(p_member_id);
  IF NOT EXISTS (SELECT 1 FROM public.decision_rounds WHERE id = p_round_id AND status = 'voting') THEN
    RAISE EXCEPTION 'This vote is not running.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.saved_restaurants
    WHERE id = p_saved_restaurant_id AND proposed_at IS NOT NULL AND shared_at IS NULL
  ) THEN
    RAISE EXCEPTION 'This restaurant is not a proposal.';
  END IF;
  INSERT INTO public.decision_votes (round_id, member_id, saved_restaurant_id)
  VALUES (p_round_id, p_member_id, p_saved_restaurant_id)
  ON CONFLICT (round_id, member_id)
  DO UPDATE SET saved_restaurant_id = EXCLUDED.saved_restaurant_id, voted_at = now();
END;
$$;

CREATE FUNCTION public.finish_decision_vote(p_round_id uuid, p_member_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  winner uuid;
  created_meal_id uuid;
BEGIN
  PERFORM private.assert_active_group_member(p_member_id);
  PERFORM 1 FROM public.decision_rounds WHERE id = p_round_id AND status = 'voting' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This vote is not running.';
  END IF;

  -- Meiste Stimmen gewinnt; bei Gleichstand entscheidet der Zufall.
  SELECT vote.saved_restaurant_id INTO winner
    FROM public.decision_votes AS vote
    JOIN public.saved_restaurants AS saved ON saved.id = vote.saved_restaurant_id
    WHERE vote.round_id = p_round_id AND saved.proposed_at IS NOT NULL AND saved.shared_at IS NULL
    GROUP BY vote.saved_restaurant_id
    ORDER BY count(*) DESC, random()
    LIMIT 1;
  IF winner IS NULL THEN
    RAISE EXCEPTION 'No votes have been cast yet.';
  END IF;

  created_meal_id := private.create_meal_from_proposal(winner);
  UPDATE public.decision_rounds
    SET status = 'closed', closed_at = now(), winning_meal_id = created_meal_id
    WHERE id = p_round_id;
  RETURN created_meal_id;
END;
$$;

CREATE FUNCTION public.cancel_decision_vote(p_round_id uuid, p_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM private.assert_active_group_member(p_member_id);
  UPDATE public.decision_rounds
    SET status = 'cancelled', closed_at = now()
    WHERE id = p_round_id AND status = 'voting';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This vote is not running.';
  END IF;
END;
$$;

-- Zufallsentscheidung: Wer zuletzt eine Fressung vorgeschlagen hat, wird ausgenommen.
CREATE FUNCTION public.decide_randomly(p_member_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  last_member_id uuid;
  winner uuid;
  created_meal_id uuid;
BEGIN
  PERFORM private.assert_active_group_member(p_member_id);
  IF EXISTS (SELECT 1 FROM public.decision_rounds WHERE status = 'voting') THEN
    RAISE EXCEPTION 'A vote is running. Finish or cancel it first.';
  END IF;

  SELECT creator_member_id INTO last_member_id
    FROM public.meals
    WHERE NOT is_neutral AND creator_member_id IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 1;

  SELECT id INTO winner
    FROM public.saved_restaurants
    WHERE proposed_at IS NOT NULL AND shared_at IS NULL
      AND (last_member_id IS NULL OR member_id <> last_member_id)
    ORDER BY random()
    LIMIT 1;
  IF winner IS NULL THEN
    RAISE EXCEPTION 'No eligible proposals. The last proposer is excluded.';
  END IF;

  created_meal_id := private.create_meal_from_proposal(winner);
  RETURN created_meal_id;
END;
$$;

REVOKE ALL ON FUNCTION public.start_decision_vote(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cast_decision_vote(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finish_decision_vote(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_decision_vote(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_randomly(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.start_decision_vote(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cast_decision_vote(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finish_decision_vote(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_decision_vote(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.decide_randomly(uuid) TO authenticated;
