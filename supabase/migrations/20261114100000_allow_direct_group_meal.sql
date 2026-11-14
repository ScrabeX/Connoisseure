-- Direktes Anlegen einer Fressung ohne Abstimmung (die Gruppe hat sich schon geeinigt):
-- Personen dürfen wieder eine eigene ausstehende Fressung anlegen, neben neutralen Fressungen.
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
