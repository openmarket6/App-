-- =============================================================================
-- 0043  The full plans, engineering and inspection catalogue
-- =============================================================================
--
-- Everything a Florida contractor can order from this firm, in one catalogue:
-- architectural and site, structural, the three MEP disciplines, fire and life
-- safety, civil, specialty structures, calculations, as-built records, and the
-- inspections and recertifications.
--
-- WHY THE INSPECTIONS ARE HERE. They are not drafting, but they are ordered the
-- same way and travel the same route — request, quote, assign, deliver — and a
-- contractor looking for a milestone inspection should not have to find a
-- different screen. Three of them are statutory and worth naming precisely,
-- because getting them confused is expensive:
--
--   MILESTONE INSPECTION is Fla. Stat. 553.899. Condominium and cooperative
--   buildings three storeys or more, at 30 years of age (25 within three miles
--   of the coast), then every ten. Phase one is visual; phase two follows only
--   where phase one finds substantial structural deterioration. A
--   Florida-licensed architect or engineer performs it and a sealed report goes
--   to the association AND the local building official.
--
--   BUILDING RECERTIFICATION (the 40-year) is a Miami-Dade and Broward county
--   ordinance, covering structural AND electrical. It is a different
--   requirement from the milestone inspection, and a building can owe both.
--
--   THE STRUCTURAL INTEGRITY RESERVE STUDY is Fla. Stat. 718.112(2)(g) — a
--   reserve funding study for the structural components, which may be run
--   alongside a milestone inspection.
--
-- AS-BUILT PLANS AND AS-BUILT LETTERS ARE BOTH ORDERABLE, per trade. They are
-- different deliverables: the plans are the approved drawings revised to show
-- what was built; the letter is the licensed trade contractor certifying it
-- over their licence number. A department asking for one will not take the
-- other.
--
-- GENERATED, NOT TYPED. The rows below come from scripts/drafting-catalogue-sql.ts,
-- which reads the same catalogue the screen renders from. The create handler
-- validates against THIS TABLE, so a service in one and not the other means a
-- contractor picks an option and is refused by a server that just offered it.
--
-- Existing rows keep their price: `do update` touches only label and
-- sort_order, so a rate edited in Settings is not stamped back to the
-- placeholder on the next deploy.

insert into ocs.drafting_services
  (service, label, base_cents, quote_required, typical_turnaround_days, requires_seal, sort_order)
values
  ('ARCHITECTURAL_PLANS', 'Architectural plan set', 250000, true, 10, true, 10),
  ('SITE_PLAN', 'Site plan', 45000, false, 4, false, 20),
  ('FLOOR_PLAN', 'Floor plan', 60000, false, 4, false, 30),
  ('DEMOLITION_PLAN', 'Demolition plan', 55000, true, 5, true, 40),
  ('ACCESSIBILITY_PLAN', 'Accessibility / ADA compliance plan', 85000, true, 6, true, 50),
  ('INTERIOR_BUILDOUT', 'Interior build-out / tenant improvement', 180000, true, 9, true, 60),
  ('STRUCTURAL_ENGINEERING', 'Structural engineering (signed & sealed)', 180000, true, 8, true, 70),
  ('FOUNDATION_PLAN', 'Foundation plan', 95000, true, 7, true, 80),
  ('TRUSS_LAYOUT', 'Truss layout & engineering', 90000, true, 7, true, 90),
  ('WIND_LOAD_CALCS', 'Wind load calculations', 65000, false, 4, true, 100),
  ('OPENING_PROTECTION', 'Opening protection / shutter plans', 70000, true, 5, true, 110),
  ('RETAINING_WALL', 'Retaining wall design', 90000, true, 7, true, 120),
  ('STRUCTURAL_LETTER', 'Structural engineer letter', 45000, true, 4, true, 130),
  ('MECHANICAL_PLANS', 'Mechanical plans (HVAC)', 85000, true, 7, true, 140),
  ('ELECTRICAL_PLANS', 'Electrical plans', 85000, true, 7, true, 150),
  ('PLUMBING_PLANS', 'Plumbing plans', 75000, true, 7, true, 160),
  ('MEP_DESIGN', 'MEP design (combined)', 120000, true, 9, true, 170),
  ('GAS_PIPING', 'Gas piping plans', 65000, true, 6, true, 180),
  ('GENERATOR_PLANS', 'Standby generator plans', 90000, true, 7, true, 190),
  ('SOLAR_PV_PLANS', 'Solar PV / battery storage plans', 85000, true, 6, true, 200),
  ('ELEVATOR_PLANS', 'Elevator / lift plans', 110000, true, 9, true, 210),
  ('LOW_VOLTAGE_PLANS', 'Low voltage / data / security plans', 60000, true, 6, false, 220),
  ('LIFE_SAFETY_PLANS', 'Life safety plans', 95000, true, 8, true, 230),
  ('FIRE_SPRINKLER_PLANS', 'Fire sprinkler plans (NFPA 13/13D/13R)', 140000, true, 9, true, 240),
  ('FIRE_ALARM_PLANS', 'Fire alarm plans (NFPA 72)', 120000, true, 9, true, 250),
  ('FIRE_PUMP_PLANS', 'Fire pump plans', 130000, true, 9, true, 260),
  ('HOOD_SUPPRESSION', 'Kitchen hood & suppression plans', 110000, true, 8, true, 270),
  ('CIVIL_ENGINEERING', 'Civil engineering', 220000, true, 12, true, 280),
  ('DRAINAGE_GRADING', 'Drainage & grading plan', 110000, true, 8, true, 290),
  ('STORMWATER_PLAN', 'Stormwater management plan', 140000, true, 10, true, 300),
  ('PAVING_PLAN', 'Paving & parking plan', 90000, true, 7, true, 310),
  ('UTILITY_PLAN', 'Utility connection plan', 85000, true, 7, true, 320),
  ('LANDSCAPE_IRRIGATION', 'Landscape & irrigation plan', 70000, true, 6, false, 330),
  ('SURVEY_COORDINATION', 'Survey coordination', 40000, true, 5, false, 340),
  ('POOL_SPA_PLANS', 'Pool & spa plans', 95000, true, 7, true, 350),
  ('SCREEN_ENCLOSURE', 'Screen enclosure plans', 65000, true, 6, true, 360),
  ('DOCK_SEAWALL', 'Dock, seawall & marine structures', 160000, true, 12, true, 370),
  ('MODULAR_PLACEMENT', 'Modular / mobile home placement plans', 70000, true, 6, true, 380),
  ('SIGNAGE_PLANS', 'Signage plans', 50000, true, 5, true, 390),
  ('ENERGY_CALCS', 'Energy code calculations', 35000, false, 3, false, 400),
  ('MANUAL_J_S_D', 'Manual J / S / D load calculations', 45000, false, 4, false, 410),
  ('PRODUCT_APPROVAL_PACKAGE', 'Product approval / NOA package', 35000, false, 3, false, 420),
  ('FLOOD_ELEVATION', 'Flood elevation certificate coordination', 50000, true, 6, false, 430),
  ('MILESTONE_INSPECTION_PHASE_1', 'Milestone inspection — phase one', 350000, true, 21, true, 440),
  ('MILESTONE_INSPECTION_PHASE_2', 'Milestone inspection — phase two', 750000, true, 35, true, 450),
  ('BUILDING_RECERTIFICATION', 'Building recertification (40/50-year)', 450000, true, 28, true, 460),
  ('STRUCTURAL_INTEGRITY_RESERVE_STUDY', 'Structural integrity reserve study (SIRS)', 550000, true, 30, true, 470),
  ('THRESHOLD_INSPECTION', 'Threshold inspection services', 600000, true, 30, true, 480),
  ('SPECIAL_INSPECTOR', 'Special inspector services', 250000, true, 14, true, 490),
  ('PRIVATE_PROVIDER_INSPECTION', 'Private provider plan review & inspection', 300000, true, 14, true, 500),
  ('WIND_MITIGATION_INSPECTION', 'Wind mitigation inspection (OIR-B1-1802)', 25000, false, 5, false, 510),
  ('FOUR_POINT_INSPECTION', 'Four-point inspection', 25000, false, 5, false, 520),
  ('ROOF_CERTIFICATION', 'Roof condition certification', 25000, false, 5, false, 530),
  ('BALCONY_RAILING_INSPECTION', 'Balcony & railing inspection', 180000, true, 14, true, 540),
  ('ELEVATOR_RECERTIFICATION', 'Elevator recertification coordination', 90000, true, 14, false, 550),
  ('REVISION', 'Plan revision', 30000, false, 3, false, 560),
  ('DELTA_REVISION', 'Delta revision (post-permit)', 45000, true, 5, true, 570),
  ('CORRECTION_RESPONSE', 'Correction response package', 35000, false, 4, false, 580),
  ('AS_BUILT', 'As-built plan set (all trades)', 75000, true, 6, false, 590),
  ('AS_BUILT_PLANS_ROOFING', 'As-built plans — Roofing', 55000, true, 6, false, 600),
  ('AS_BUILT_PLANS_ELECTRICAL', 'As-built plans — Electrical', 55000, true, 6, false, 610),
  ('AS_BUILT_PLANS_PLUMBING', 'As-built plans — Plumbing', 55000, true, 6, false, 620),
  ('AS_BUILT_PLANS_MECHANICAL', 'As-built plans — Mechanical (HVAC)', 55000, true, 6, false, 630),
  ('AS_BUILT_PLANS_STRUCTURAL', 'As-built plans — Structural', 55000, true, 6, false, 640),
  ('AS_BUILT_PLANS_BUILDING', 'As-built plans — Building (general)', 55000, true, 6, false, 650),
  ('AS_BUILT_PLANS_WINDOWS_AND_DOORS', 'As-built plans — Windows & doors', 55000, true, 6, false, 660),
  ('AS_BUILT_LETTER_ROOFING', 'As-built letter — Roofing', 15000, false, 3, false, 670),
  ('AS_BUILT_LETTER_ELECTRICAL', 'As-built letter — Electrical', 15000, false, 3, false, 680),
  ('AS_BUILT_LETTER_PLUMBING', 'As-built letter — Plumbing', 15000, false, 3, false, 690),
  ('AS_BUILT_LETTER_MECHANICAL', 'As-built letter — Mechanical (HVAC)', 15000, false, 3, false, 700),
  ('AS_BUILT_LETTER_STRUCTURAL', 'As-built letter — Structural', 15000, false, 3, false, 710),
  ('AS_BUILT_LETTER_BUILDING', 'As-built letter — Building (general)', 15000, false, 3, false, 720),
  ('AS_BUILT_LETTER_WINDOWS_AND_DOORS', 'As-built letter — Windows & doors', 15000, false, 3, false, 730)
on conflict (service) do update
  set label = excluded.label,
      sort_order = excluded.sort_order;
