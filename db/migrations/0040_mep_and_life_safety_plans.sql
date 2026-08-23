-- =============================================================================
-- 0040  The disciplines a building department actually reviews separately
-- =============================================================================
--
-- The catalogue offered MEP_DESIGN as one combined item. A building department
-- does not review it that way: mechanical, electrical and plumbing each go to
-- their own plans examiner, each comes back with its own corrections, and each
-- is commonly sealed by a different engineer. A contractor who needs only the
-- electrical had no way to ask for it except by buying all three.
--
-- Life safety is its own discipline for a sharper reason. On a commercial job
-- egress, occupancy and fire-rated assemblies are reviewed by the fire marshal
-- rather than the building department, on a separate track with a separate
-- approval. It is asked for by name, and it was not on the list at all.
--
-- MEP_DESIGN IS KEPT. Orders already reference it, and a combined package is a
-- real thing to sell. Removing the value would leave those rows carrying a key
-- nothing maps to a label.
--
-- Prices are placeholders, deliberately in the same shape as the ones seeded in
-- 0023 -- quote_required is true on all four, because a discipline package is
-- scoped per job and a published price would be a number nobody could honour.
-- The rate book is editable in Settings; these are a starting point, not a
-- commitment.
--
-- sort_order slots them in beside MEP_DESIGN (30) rather than at the end, so
-- the four MEP rows read together wherever the catalogue is ordered by it.

insert into ocs.drafting_services
  (service, label, base_cents, quote_required, typical_turnaround_days, requires_seal, sort_order)
values
  ('MECHANICAL_PLANS',  'Mechanical plans (HVAC)',  85000, true, 7, true, 26),
  ('ELECTRICAL_PLANS',  'Electrical plans',         85000, true, 7, true, 27),
  ('PLUMBING_PLANS',    'Plumbing plans',           75000, true, 7, true, 28),
  ('LIFE_SAFETY_PLANS', 'Life safety plans',        95000, true, 8, true, 32)
on conflict (service) do nothing;

-- The combined package is now one option among four rather than the only way
-- to order any of them.
update ocs.drafting_services
   set label = 'MEP design (combined)'
 where service = 'MEP_DESIGN' and label = 'MEP design';

comment on table ocs.drafting_services is
  'The drafting catalogue. Mechanical, electrical, plumbing and life safety '
  'are separate rows because each is reviewed separately -- by a different '
  'plans examiner, and for life safety by the fire marshal rather than the '
  'building department.';
