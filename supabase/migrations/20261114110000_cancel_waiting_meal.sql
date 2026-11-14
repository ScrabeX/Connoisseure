-- Eine ausstehende (noch nicht gestartete) Fressung abbrechen, z. B. weil es keinen Tisch gab.
-- Erlaubt für den Ersteller; neutrale Fressungen darf jede aktive Person abbrechen.
-- Das Restaurant einer persönlichen Fressung kommt zurück auf die Merkliste des Erstellers.
CREATE FUNCTION public.cancel_waiting_meal(p_meal_id uuid, p_actor_member_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  meal public.meals%ROWTYPE;
  target_id uuid;
BEGIN
  PERFORM private.assert_active_group_member(p_actor_member_id);

  SELECT * INTO meal FROM public.meals WHERE id = p_meal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Meal was not found.';
  END IF;
  IF meal.status <> 'waiting' THEN
    RAISE EXCEPTION 'Only a waiting meal may be cancelled.';
  END IF;
  IF NOT meal.is_neutral AND meal.creator_member_id <> p_actor_member_id THEN
    RAISE EXCEPTION 'Only the creator may cancel this meal.';
  END IF;

  IF NOT meal.is_neutral THEN
    SELECT id INTO target_id
      FROM public.saved_restaurants
      WHERE member_id = meal.creator_member_id
        AND restaurant_name = meal.restaurant_name
        AND place = meal.place
      ORDER BY created_at DESC
      LIMIT 1;

    IF target_id IS NULL THEN
      INSERT INTO public.saved_restaurants (member_id, restaurant_name, place, maps_url, note)
      VALUES (meal.creator_member_id, meal.restaurant_name, meal.place, meal.maps_url, meal.note);
    ELSE
      UPDATE public.saved_restaurants SET shared_at = NULL, proposed_at = NULL WHERE id = target_id;
    END IF;
  END IF;

  DELETE FROM public.meals WHERE id = p_meal_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_waiting_meal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_waiting_meal(uuid, uuid) TO authenticated;
