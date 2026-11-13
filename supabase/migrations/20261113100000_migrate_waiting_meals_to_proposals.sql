-- Alte, noch nicht gestartete Fressungen (aus dem früheren Direkt-Anlegen) werden
-- in das neue System überführt: Sie landen auf der Merkliste ihres Erstellers,
-- der jeweils neueste davon wird dessen Vorschlag (falls die Person noch keinen hat).
-- Die alte ausstehende Fressung wird danach entfernt.
-- Gestartete, laufende und abgeschlossene sowie neutrale Fressungen bleiben unberührt.
DO $$
DECLARE
  legacy record;
  target_id uuid;
BEGIN
  FOR legacy IN
    SELECT m.*
    FROM public.meals AS m
    WHERE m.status = 'waiting'
      AND NOT m.is_neutral
      AND m.creator_member_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.meal_participants AS p WHERE p.meal_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM public.ratings AS r WHERE r.meal_id = m.id)
    ORDER BY m.created_at DESC
  LOOP
    -- Gleicher Eintrag bereits auf der Merkliste (z. B. früher geteilt)? Dann wiederverwenden.
    SELECT id INTO target_id
      FROM public.saved_restaurants
      WHERE member_id = legacy.creator_member_id
        AND restaurant_name = legacy.restaurant_name
        AND place = legacy.place
      ORDER BY created_at DESC
      LIMIT 1;

    IF target_id IS NULL THEN
      INSERT INTO public.saved_restaurants (member_id, restaurant_name, place, maps_url, note, created_at)
      VALUES (legacy.creator_member_id, legacy.restaurant_name, legacy.place,
              legacy.maps_url, legacy.note, legacy.created_at)
      RETURNING id INTO target_id;
    ELSE
      UPDATE public.saved_restaurants SET shared_at = NULL WHERE id = target_id;
    END IF;

    -- Schleife läuft vom neuesten zum ältesten: Wer noch keinen Vorschlag hat, bekommt den neuesten.
    IF NOT EXISTS (
      SELECT 1 FROM public.saved_restaurants
      WHERE member_id = legacy.creator_member_id AND proposed_at IS NOT NULL AND shared_at IS NULL
    ) THEN
      UPDATE public.saved_restaurants SET proposed_at = now() WHERE id = target_id;
    END IF;

    DELETE FROM public.meals WHERE id = legacy.id;
  END LOOP;
END;
$$;
