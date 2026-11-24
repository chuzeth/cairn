# Pierre: athlete profile, 24/11/2026

Sources: read-only copy `profile.sqlite` (103 activities from 27/05 to 23/11/2026, 76 with stream analysis; 392 physiology models; 277 planned sessions; check-ins; pain answers; strength tests) and `model.json` (model of 24/11). HR is wrist-optical (Garmin Venu 2, 71 of 103 activities). Provenance tags follow Cairn's vocabulary: `lab` (24/07/2025 test), `field` (Strava streams), `blended`, `default`, and `derived` (my own computation from the field data, with the method stated). **There is no training data before 27/05/2026.** Anything I say about his history before that date is unknown.

Goals: **A**, Ultra Trail Morzine-Avoriaz on 19/06/2027 (97.1 km, about 5,700 m D+/D−, technicality 3 as entered, start 06:00). **B**, Ultra Boucle de la Sarra on 22/05/2027 (6 h relay for 2 runners, 2 km / 90 m loop, start 17:00). That is 4 weeks before A.

---

## 1. Physiological capacities

| Parameter | Value | Provenance and evidence |
|---|---|---|
| Body mass | 68.6 kg, 10.8 % fat | `lab` 24/07/2025, never updated since |
| HRmax | **190–191 bpm** | `field`: 191 on the KV de Rochefort 12/06 (HR good); 187 on 11/11 and 13/11; 194 on 26/07 is flagged *doubtful* (9 spikes). Lab 187 (ramp, not maximal for HR) |
| HRrest | 55 (model) | `default`: never measured. Lab 87 was standing with the mask on |
| VO2max | **measured 64.6 ml/kg/min** (4.43 L/min); model 57.5 | Lab VO2 is measured directly. But resting VO2 of 8.94 (ref < 5) suggests a possible analyser offset of +3–4, so the true value is probably 60–62. The model's 57.5 is `blended`. **Performance-equivalent VO2 (Daniels VDOT, `derived`) is only 47–49**: 20 min at 14.37 km/h on 21/09 → 47.2; 30 min at 14.22 km/h on 13/11 → 47.8; 60 min at 13.9 km/h on 01/07 → 48.6. The 20–25 % gap between engine and flat output means poor flat running economy and/or low fractional utilisation. A flat-speed limiter, not an oxygen limiter |
| vVO2max (VMA) | lab 20.0 km/h → **field 16.5–17.5 km/h** | Model 17.8 km/h `blended`. Best flat efforts: 3 min 16.1, 5 min 15.9 km/h (13/11). Lab × 0.85 = 17.0, consistent |
| Critical speed | **14.2–14.5 km/h** (model 14.50 = 4.027 m/s, `blended`) | 20-min test on 21/09: 14.37 km/h at a mean of 174 bpm. **30 min at 14.22 km/h at 171 bpm on 13/11**, four days after the reprise. That is a valid CS proof the model does not use (`criticalSpeedEvidence.support` = 0.075, last proof 132 days old). CS/vVO2max ≈ 0.83–0.85 |
| D′ | 190 m | `blended`. Moderate to low. Not a constraint for 100 km; it matters for relay pacing |
| VT2 | **171 bpm ↔ 14.2–14.5 km/h flat** | HR `lab`. Speed: lab 16.8 × 0.85 = 14.3 = CS. The 15 % correction holds here |
| VT1 | **155 bpm ↔ 12.4–12.8 km/h flat (late Sept form), about 12.0 now** | HR `lab`/`blended`. Speed is `derived` from flat steady windows (|grade| < 3 %, no hard effort in the previous 3 min). Late Sept: 150–154 bpm → 12.4 km/h, 155–159 → 12.8 km/h. Nov: 11.7 and 12.2 km/h. **The model's 11.2 km/h (lab −15 %) underestimates VT1 speed. The ramp overestimate is about 3–6 % at VT1, not 15 %** |
| Heat sensitivity | 0.35 bpm/°C above 15 °C | `field`, from 35 runs May–Nov (constant in `debrief.ts`). Moderate: +5 bpm at 30 °C |
| Respiratory | CUP 48 % (ref > 55), breathing rate 60/min at max | `lab`. Breathlessness at the top end. Inspiratory muscle training is a cheap marginal gain |
| Flexibility | sit-and-reach −1 (lab) → 0 (09/10) → +2 cm (01/11) | `field` self-test |

**Climbing (VAM) curve**, model of 24/11, `field`, best mean vertical rate over each window: 1 min 1,823 · 5 min 1,290 · 10 min 1,193 · 20 min 1,173 (KV 12/06: 546 m in 27.4 min at 186 bpm, 52 % hiked) · 30 min 948 · 60 min 812 · 90 min 778 · 2 h 738 · 3 h 545 m/h. The 1–3 h values come from 26/07 (Oisans, mean altitude 2,584 m), so they are probably 5 % higher at low altitude. The 1-min value may be a GPS artifact.
**VAM at HR** (`derived`, 41 pre-layoff climbs of ≥ 5 min at ≥ 10 % grade, good HR): VAM ≈ 854 + 8.7 × (HR − 149). That gives **≈ 860 m/h at 150 bpm, 905 at VT1, 995 at 165 bpm**, on 15–20 % grades hiked 70–90 % of the time. Since the layoff (15/11): 987 m/h at 160 bpm, 819 at 162. That is 5–10 % below the pre-layoff curve at equal HR.

**Descent curve** (`field`): 10 min 2,022 · 30 min 1,782 · 60 min 1,485 · 2 h 816 m/h of vertical loss. **Speed by grade**, all pre-layoff running (`derived`, 75 h):

| Grade | −30/−60 % | −20/−30 % | −12/−20 % | −6/−12 % | −2/−6 % | flat | +6/+12 % | +12/+20 % | +20/+30 % |
|---|---|---|---|---|---|---|---|---|---|
| km/h | 6.3 | 8.1 | 11.0 | 12.1 | 12.2 | 12.1 | 7.9 | 5.6 | 4.4 |
| vertical m/h | 2,830 | 2,030 | 1,760 | 1,090 | 490 | – | 710 | 900 | 1,110 |

He runs downhill **no faster than on the flat** (−6/−12 %: 12.1 km/h, flat: 12.1). Competent trail runners gain 15–30 % at −8/−12 %. The engine's ceiling for technicality 3 at skill 1.0 is 12.8 km/h at −16 % and 10.8 at −25 %. Pierre does 11.0 and 8.1, i.e. 0.86 and 0.75 of the ceiling. Model `descentSkill` = 0.69 (`field`, clamp floor 0.6). His best −12/−20 % stretches (13–17 km/h on 24/09, 01/08, 17/07) show the legs can do it, so the gap is confidence and eccentric tolerance more than capacity.

**Recommended HR zones for prescription** (HRmax 190, VT1 155, VT2 171):

| Zone | bpm | % HRmax | Speed now (flat, Nov) | Climb | Use |
|---|---|---|---|---|---|
| Z1 recovery | < 140 | < 74 % | < 10.5 km/h | – | recovery, warm-up |
| Z2 endurance | 140–155 | 74–82 % | 10.5–12.0 | 750–900 m/h | base volume, long runs. **Cap flat easy runs at 150 until HR at 11 km/h is back to ≤ 135**. 100 km race pace for the first half = 140–152 |
| Z3 tempo | 156–165 | 82–87 % | 12.0–13.3 | 900–1,000 | long uphill steady efforts, late-specific work. Use sparingly |
| Z4 threshold | 166–176 | 87–93 % | 13.5–14.5 (≈ CS) | 1,000–1,150 | cruise intervals 6–15 min, relay reps. HR rises to 172–176 by the end of a rep |
| Z5 VO2max | ≥ 177 | ≥ 93 % | 15.5–17 | 1,200–1,300 | 2–5 min uphill reps |

Compared with the app: the app's Z3 runs 155–171 and Z4 171–175. I split tempo and threshold at 165/166 so that threshold work is not prescribed with a 4-bpm window that wrist HR cannot hold. For reps under 4 min, prescribe by pace, VAM or RPE (HR lag).

## 2. Training history, 27/05 → 23/11/2026

Weekly totals (Monday start). Run = Run + TrailRun. Hike and other types are separate. The other column covers strength, stairs logged as Elliptical/Workout, and bike. Manual sessions (09/10 → 08/11) have prescribed durations and estimated D+, with no HR.

| Week | Total h | Run h | Hike h | Other h | Runs | km | D+ run | D+ hike/stairs | Longest run h |
|---|---|---|---|---|---|---|---|---|---|
| 25/05 | 3.0 | 3.0 | – | – | 3 | 24.8 | 1,138 | – | 1.4 |
| 01/06 | 4.3 | 4.3 | – | – | 4 | 39.8 | 1,266 | – | 1.5 |
| 08/06 | 2.3 | 2.3 | – | – | 4 | 21.5 | 905 | – | 0.8 (KV) |
| 15/06 | 3.2 | 3.2 | – | – | 3 | 35.0 | 663 | – | 1.3 |
| 22/06 | 2.6 | 2.6 | – | – | 3 | 29.1 | 487 | – | 1.0 |
| 29/06 | 6.2 | 2.9 | 3.3 | – | 2 | 35.3 | 340 | 1,387 | 1.6 |
| 06/07 | 3.9 | 3.9 | – | – | 4 | 41.1 | 1,131 | – | 1.3 |
| 13/07 | 4.4 | 4.4 | – | – | 4 | 44.2 | 1,408 | – | 1.3 |
| 20/07 | 6.4 | 5.4 | 1.1 | – | 3 | 43.4 | **2,590** | 176 | **3.3** |
| 27/07 | 4.2 | 4.2 | – | – | 4 | 42.0 | 1,298 | – | 1.4 |
| 03/08 | 2.3 | 2.3 | – | – | 2 | 26.8 | 689 | – | 1.5 |
| 10/08 | 3.3 | 3.3 | – | – | 4 | 37.0 | 687 | – | 1.0 |
| 17/08 | 4.0 | 4.0 | – | – | 5 | 45.1 | 920 | – | 1.2 |
| 24/08 | **7.6** | **7.6** | – | – | 5 | **51.7** | 2,398 | – | 2.1 |
| 31/08 | 2.1 | 2.1 | – | – | 2 | 23.7 | 388 | – | 1.7 |
| 07/09 | 1.7 | 1.7 | – | – | 2 | 14.9 | 478 | – | 0.9 (planned break 03–13/09, Crete) |
| 14/09 | 7.9 | 2.6 | 5.4 | – | 2 | 26.1 | 466 | 1,356 | 1.3 |
| 21/09 | 4.9 | 4.9 | – | – | 5 | 49.8 | 827 | – | 1.5 |
| 28/09 | 3.9 | 3.9 | – | – | 4 | 40.2 | 538 | – | 1.1 |
| 05/10 | 2.9 | 0 | – | 2.9 | 0 | – | – | – | elbow fracture 03/10 (bike fall) |
| 12/10 | 7.1 | 0 | – | 7.1 | 0 | – | – | ~275 | strength block (daily) |
| 19/10 | 8.8 | 0 | 3.2 | 5.6 | 0 | – | – | 905 | |
| 26/10 | 8.5 | 0 | 4.5 | 4.0 | 0 | – | – | 703 | |
| 02/11 | 4.5 | 0 | 2.3 | 2.2 | 0 | – | – | 450 | impact preparation |
| 09/11 | 4.6 | 4.6 | – | – | 4 | **49.3** | 968 | – | 1.7 |
| 16/11 | 2.5 | 2.5 | – | – | 3 | 28.5 | 351 | – | 1.0 (calf) |
| 23/11 | 1.4 | 1.4 | – | – | 1 | 14.0 | 288 | – | 1.4 |

- **Totals, 27/05–02/10 (18 weeks of running):** 68.5 h, 672 km, 18,600 m D+ across 65 runs. That is **3.8 h, 37 km and 1,030 m D+ per week**. The best 28-day block, to 31/08, was 17.2 h, 161 km and 4,695 m (4.3 h/week). Peak week: 7.6 h, 51.7 km, 2,398 m (24/08, Chamonix area).
- **Longest efforts:** 26/07 trail, 24.1 km and +1,699 m in 3 h 18 moving (3 h 59 elapsed) at a mean altitude of 2,584 m (Oisans); 04/07 hike in the Chablais (Abondance area, about 15 km from Morzine), 12.3 km and +1,387 m in 3 h 17 moving (5 h 45 elapsed); 29/08 trail, 15.3 km and +1,068 m in 2 h 05 moving (4 h 03 elapsed, Chamonix area); 02/09, 19.3 km flat-ish in 1 h 43; 15/11, 16.5 km and +664 m in 1 h 42. **No run over 25 km or 3.3 h in the dataset.**
- **Quality:** 21 sessions with ≥ 8 min in Z4+Z5 or ≥ 25 min in Z3, about one per week. They were flat threshold or VO2 sessions (01/07: 60 min at 13.9 km/h; 19/06; 11/07; 30/07; 10/08; 19/08; 23/08; 18/09: 10 × 1–3.5 min at 14–15 km/h), hill sessions (03/06, 07/06, 15/07), a guided downhill session on 24/09 (6 × 3 min, −543 m), the 20-min test on 21/09, and since the reprise 13/11 (threshold run as 30 min at 14.2 km/h, 17 min in Z5), 17/11 (5 × 80 s hill at +5 % plus flat reps). Intensity distribution May–Sep: Z1 45 %, Z2 28 %, Z3 21 %, Z4 3 %, Z5 3 %, so pyramidal with a heavy Z3 share. **Since 09/11: 37 % above VT1 (Z3 28 %, Z5 7 %).** The reprise has been run too hard.
- **Races:** KV de Rochefort on 12/06 (2.9 km, +547 m, 27:39 moving, HR 185 mean / 191 max, VAM 1,173 m/h). No placing is recorded. No other race is tagged (`workout_type` race = none). The 32 km of 18/10 (Grisemottes, check-in of 20/09) was lost to the fracture.
- **Consistency:** 2–5 runs a week, rarely 5. Volume swings of ±50 % from week to week (for example 7.6 → 2.1 → 1.7 h). There are no regular long runs: only 3 runs over 2 h in 6 months. Plan adherence since 14/09: 31 completed, 12 replaced, 10 missed. Replacements tend to go *harder or longer*: 15/11 was prescribed as 65 min / 250 m and became 102 min / 664 m (load 110 vs 72); 20/11 was prescribed as a 40-min flat walk and became 10.4 km at 153 bpm with 6 min in Z5.
- **Pauses and injuries:** a planned break 03–13/09; elbow fracture 03/10 with no running until 08/11 (24-day home strength block from 09/10 to 01/11, stairs at threshold with a weighted pack, 2 weeks of impact preparation); calf pain since the reprise (§4).
- **Strength tests 09/10 → 01/11** (`field`, self-administered): single-leg calf raises **L 91 → 99, R 117 → 134 (left/right ratio 74 %)**; single-leg bridge L 32 → 40, R 36 → 51 (78 %); eyes-closed balance L 22 → 60 s, R 60 s; knee-to-wall L 11, R 9 → 11 cm; wall sit 2:10.

## 3. Strengths and limiters

**For the 100 km / 5,700 m race**

1. **Race-duration specificity is the main limiter.** The longest effort on record (3.3 h, 1,700 m) is about **one fifth of the expected race time** (16–19 h). Training volume averaged 3.8 h/week, peaking at 7.6 h. Typical top-10 % finishers at 100 km / 6,000 m carry 10–15 h/week for months, with 5–8 h training days. The gap is both aerobic and mechanical.
2. **Durability is weak or untested at length.** Model −4.4 %/h efficiency loss (`field`), but the value has wandered between 3.5 and 6.5 since September, so confidence is low. Decoupling is < 5 % on flat runs up to 1 h 45 (02/09: −3.3 %; 23/11: −1.6 %) but **16–24 % on mountain runs of 1.5–3.3 h** (31/05: 21.5 %; 29/08: 16.5 %; 26/07: 23.5 % at 2,584 m, efficiency 0.0188 → 0.0144). Terrain and altitude confound these numbers. Even so, nothing in the data shows that he can hold output beyond 3 h.
3. **Climbing is the main strength.** About 860–905 m/h at 150–155 bpm on 15–20 % grades, 812 m/h sustained for 60 min, and 738 m/h for 2 h at altitude. That is solid upper-amateur hiking efficiency. Climbing is also the biggest time block at Morzine (about 9–10 h of the race), so each +5 % sustained VAM is worth about 25–30 min.
4. **Descending is a clear limiter.** He is no faster on −6/−12 % than on the flat, at 0.75–0.86 of the engine ceiling on steep grades, with skill index 0.69. With 5,700 m of D−, about 4.5–5.5 h of the race is spent descending. A 10 % gain is worth about 25–30 min **and** spares the quads for the last 30 km. Eccentric tolerance is low right now: the running mechanical load average (42-day) is 4.5 against 9–10 in August.
5. **The aerobic ceiling is good; flat economy is mediocre.** VO2 is 60–65 measured, but flat-speed equivalent VDOT is 47–49 (≈ 3:15–3:20 marathon shape). This matters little at Morzine (≤ 12 km/h terrain). It does argue for continuing strides and flat threshold work, because they also improve economy on runnable trail.
6. **Tissue tolerance is the current risk.** Bilateral calves hurt after the reprise week (49 km and 968 m in week one after 5 weeks off running). The left calf has a 26 % strength deficit (99 vs 134 reps). Calves and Achilles carry most of the uphill hiking load and the impact load of the loop race.
7. **Cadence is not a limiter.** Flat runs went from 168 (lab) to 170–177 (Sep) and 176–183 (Nov; 20/11 at 183–189). Hypothesis: the November jump in step rate moves load from knee to ankle and may have added to calf load. Do not push cadence further.
8. **HR drift and heat:** heat coefficient 0.35 bpm/°C (moderate). In summer, HR at 11 km/h was 140–150 against 131 in late September. That is partly heat, partly lower fitness. Morzine late June starts at 06:00 but crosses midday in the valleys. Two to three weeks of heat exposure are worth planning in June.
9. **Respiratory and technical:** CUP 48 % with breathlessness at max points to a possible IMT gain (small). There is no direct measure of technicality (rocky terrain). The descent proxy above is the best available.

**For the 6 h relay (about 18 min cycle)**

- His profile fits it better: CS 14.2–14.5 km/h, 5-min VAM 1,290, 20-min VAM 1,173, and threshold quality preserved through the layoff.
- **Lap estimate** (`derived`): 2 km with +90/−90 m is equivalent to about 2.5 km of flat effort. At CS-equivalent effort that gives **≈ 9:30–10:30 per lap**. The 9:00 assumed in the race entry would need a flat-equivalent of about 16.5 km/h, which is VO2 pace and cannot be repeated about 20 times. A realistic plan is 9:45–10:15 early and 10:30 late, which means **17–19 laps each** if both runners are matched.
- The limiters are repeating near-CS efforts for 3 h of work (glycogen, durability at intensity), and descending speed on the loop. Recovery between laps (about 8–9 min) is ample for D′ = 190 m.

## 4. Current state (24/11/2026)

- **Fitness (CTL-like, metabolic, 42-day EWMA of rTSS):** running data only, **21** (peak 36.3 on 02/09; 32.9 on 02/10; low point 14.2 on 08/11). If the strength and stair sessions count at their planned loads (`default`), CTL stays about 33–35 through the layoff and is 35 today. TSB (7-day minus 42-day) is about −8 on running data alone. **Mechanical (descent/eccentric) average: 4.5 against about 10 in Aug–Sep, i.e. 45 %.**
- **Aerobic gap.** HR at 11.0 km/h flat, using the app's method (median of steady windows corrected at 22 bpm per m/s, `derived`): 131–132 on 29/09–01/10 (best), 149.7 on 09/11, 155.1 on 11/11, 152.0 on 15/11, 145.4 on 20/11, **143.1 on 23/11**. The gap is **+11 bpm, closing by about 4–6 bpm/week** over the last fortnight (run-to-run error about 4 bpm). Caveat: the late, flat windows of 23/11 read 132–137 bpm at 11.0–11.6 km/h, so the real gap may be about 5–8 bpm. Flat speed at 150–154 bpm is 11.7 km/h against 12.4 in late Sept (−6 %). **The top end is intact:** 30 min at 14.22 km/h at 171 bpm on 13/11, against 14.37 at 174 bpm on 21/09. The layoff cost base and run-specific tissue, not the ceiling. The stair threshold work kept the ceiling.
- **Climbing at HR:** about 5–10 % below pre-layoff (15/11).
- **Calves** (athlete answers):

  | Date | Morning pain | Pain in run | Pattern |
  |---|---|---|---|
  | 10/11 | 1 | | |
  | 14/11 | | 1 (13/11 run) | |
  | 18/11 | 2 | 3 (17/11 hills) | eases |
  | 19/11 | 4 | **5 (18/11 easy 42 min at 128 bpm)** | **steady** |
  | 24/11 | 2 | | |

  He ran 10.4 km with Z5 on 20/11 and 14 km in 81 min on 23/11 regardless. Bilateral, diffuse pain that peaked 3–4 days after the largest load jumps (15/11: +166 % D+ against the plan; 17/11: hills) suggests load-driven muscle adaptation rather than a focal strain. Still, 5/10 that does not ease during an easy run is above any return-to-run tolerance.
- **Readiness:** no resting HR, HRV, sleep or body-mass data since 02/10 (8 check-ins in total). Readiness rests on pain and HR at reference speed alone. **I would hold the build at about 3–4 h/week of running until calf pain is ≤ 1/10 for 7 days.** The plan for 24/11–05/12 (footings of 28–45 min, long run of 1 h 30 on 05/12) fits that.

## 5. Training implications

**Priority order:**
1. Calf and Achilles capacity, plus eccentric quads. Nothing else can progress without it.
2. Aerobic volume in Z2, with long-run duration as the main lever.
3. Vertical volume (D+, then D−).
4. Downhill skill.
5. Threshold and uphill VO2, kept rather than built (the ceiling is intact).
6. Race-specific work: mountain back-to-backs, fuelling at 60–90 g/h, loop reps for the relay.

**Session types that fit:**
- **Uphill VO2:** 5–6 × 3–4 min at 1,200–1,300 m/h on 12–20 % (HR reaching ≥ 177). Low eccentric cost, so it is his best quality session while the calves heal. Use uphill treadmill to take out the D−.
- **Threshold:** 3 × 10–12 min or 2 × 20 min at 166–174 bpm. Flat at 13.8–14.3 km/h or uphill at 1,000–1,100 m/h. From March, add long uphill tempo (2 × 25–30 min at 158–166).
- **Downhill eccentric:** from late December, 1 session every 7–10 days. Examples: 6–8 × 2–3 min fast descents at −10/−15 % (target 13–15 km/h), or "quad blasters" on Fourvière with walk-up recovery. Keep 72 h before the next heavy D−. Back it with heavy strength twice a week: Bulgarian split squat, step-down, single-leg RDL, and **seated soleus raises plus standing raises, 3–4 × 6–12 heavy, until the left/right ratio is ≥ 90 %**.
- **Long runs:** in Z2 with ≥ 50 % of the time on trail and fuelling practice. From March, do monthly mountain back-to-backs (Sat 4–6 h at 1,500–2,500 m, Sun 2–3 h) and a weekday long run when working from home.
- **Relay-specific (late Apr → 22/05):** 2–3 rehearsals of 6–10 × the actual loop with 1:1 recovery, building to about 2 h of total work.
- **Fit around the dates:** after the relay, recover through 26/05, do one big mountain weekend on 29–31/05, then a 2.5-week taper. So the biggest load must land in **April and the first half of May**.

**Safe progression limits from today's state:**
- **Running time:** +≤ 10 %/week (and ≤ +30 min/week while under 6 h), with an easier week every 4th (or 3rd once above 10 h). Bike or flat walking can add aerobic volume without calf impact.
- **Intensity:** at most 1 quality session a week until the calves have been 3 weeks at ≤ 1/10, then 2. Easy runs capped at 150 bpm flat / 155 climbing. **Execute what is prescribed. The extras of 15/11 and 20/11 are the most likely cause of the 19/11 flare.**
- **Long run:** ≤ 30–35 % of weekly running time. +10–15 min/week up to 2.5 h, then +20–30 min every 1–2 weeks. Rough path: 1 h 30 (early Dec) → 2 h 30 (end Jan) → 3 h 30–4 h (March) → 5–6 h (April), plus one 7–8 h day (40–50 km, 2,500–3,000 m) by early May.
- **D+:** +≤ 15 %/week from about 600–800 m/week now, to about 2,000 m by the end of January and 3,000 by March. **D−:** +≤ 10 %/week. Keep D− ≤ D+ in Lyon (treadmill incline for D+). No single session over 1.5 × the largest D− of the previous 4 weeks.

**Red flags (stop or regress one step):**
- Calf or Achilles pain ≥ 3/10 during a run, or pain that does not ease ("steady" or "worsens").
- Morning pain higher than the day before, or morning stiffness lasting more than 30 min.
- Focal tenderness, or pain on single-leg hops.
- HR at 11 km/h rising more than 8 bpm (2 × typical error) above its trend without heat.
- Left calf raise count not improving.
- Any week with running time more than 1.3 × the 4-week average.
- Missing check-ins: start logging resting HR, sleep and body mass so readiness stops resting on pain alone.

## 6. Projection (uncertain; the data start in 05/2026)

- **Volume reachable by April–May 2027, if calves settle by mid-December:**
  - Usual weeks: 10–12 h, 70–90 km, 3,000–4,000 m D+.
  - Key mountain weeks: 13–14 h, 5,000–6,500 m.
  - Longest day: 6–8 h.
  - Running CTL about 65–80 by early May (from 21).
  - At 3.8 h/week of history, this is about a ×3 increase over 5 months. Feasible, but the error margin is a tissue injury, not fitness.
- **100 km finish time** (`derived`, uncertainty ±1.5 h):
  - Method: effort-km = 97 + 57 = 154. His current mountain moving pace is about 12.4 effort-km/h over 3 h (26/07, 29/08). The usual 100-km-to-3-h ratio is 0.62–0.72, plus fade at −4.4 %/h. The race overall climbing rate needed is 5,700 / T: 356 m/h for 16 h, against 545 m/h over 3 h today.
  - **Base case 16:30–18:30**, if the build goes to plan with a 6–8 h long day and trained descents.
  - **Optimistic 15:00–16:30**: 12–14 h weeks through April–May, VAM +5–8 %, descent skill index ≥ 0.8, no setback.
  - **Pessimistic 19–22 h** (or DNF risk from quads or calves): build stuck below 8 h/week or longest run under 4–5 h.
- **Top 5–10 %:** I have no field data for this race. For 100 km races with 5,500–6,000 m, the top-10 % cutoff usually falls around **15:30–18:00**, depending on field depth. The 2026 Morzine results (20/06/2026) should be pulled to set the target. On today's evidence, top 10 % is a stretch that needs the optimistic case, and top 15–25 % is the base case.
- **Relay:** 17–19 laps each at 9:45–10:30. The relay favours his profile more than the 100 km does.
