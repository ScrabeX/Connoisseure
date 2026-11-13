-- Jede Person hat höchstens EINEN offenen Vorschlag, und Fressungen entstehen
-- nur noch über Vorschlag + Entscheidung (Abstimmung/Zufall); direkt anlegen
-- dürfen nur noch neutrale Fressungen.

-- Bestehende Mehrfach-Vorschläge bereinigen: pro Person bleibt der neueste.
UPDATE public.saved_restaurants AS saved
SET proposed_at = NULL
WHERE saved.proposed_at IS NOT NULL
  AND saved.shared_at IS NULL
  AND EXISTS (
    SELECT 1 FROM public.saved_restaurants AS newer
    WHERE newer.member_id = saved.member_id
      AND newer.proposed_at IS NOT NULL
      AND newer.shared_at IS NULL
      AND (newer.proposed_at, newer.id) > (saved.proposed_at, saved.id)
  );

CREATE UNIQUE INDEX saved_restaurants_one_proposal_per_member_idx
  ON public.saved_restaurants (member_id)
  WHERE proposed_at IS NOT NULL AND shared_at IS NULL;

-- Merkliste-Eintrag als Vorschlag setzen; ein bisheriger Vorschlag der Person wird ersetzt.
CREATE FUNCTION public.propose_saved_restaurant(
  p_saved_restaurant_id uuid,
  p_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM private.assert_active_group_member(p_member_id);
  IF EXISTS (SELECT 1 FROM public.decision_rounds WHERE status = 'voting') THEN
    RAISE EXCEPTION 'A vote is running. Proposals cannot be changed now.';
  END IF;

  PERFORM 1 FROM public.saved_restaurants
    WHERE id = p_saved_restaurant_id AND member_id = p_member_id AND shared_at IS NULL
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Saved restaurant was not found or was already used.';
  END IF;

  UPDATE public.saved_restaurants
    SET proposed_at = NULL
    WHERE member_id = p_member_id AND proposed_at IS NOT NULL AND id <> p_saved_restaurant_id;
  UPDATE public.saved_restaurants
    SET proposed_at = now()
    WHERE id = p_saved_restaurant_id;
END;
$$;
REVOKE ALL ON FUNCTION public.propose_saved_restaurant(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.propose_saved_restaurant(uuid, uuid) TO authenticated;

-- Direktes Anlegen persönlicher Fressungen ist nicht mehr vorgesehen.
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
    AND is_neutral
    AND creator_member_id IS NULL
  );
