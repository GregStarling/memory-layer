// Retrieval-quality dataset (Phase 5.1, D1).
//
// >= 100 hand-authored cases across five named categories. Each case is a
// self-contained mini-corpus + a query + the ranked ground-truth answer.
//
// Fact shape: { k, t, cls?, ft?, trust?, ageDays?, state? }
//   k        stable per-case key (the runner maps it to an inserted row id)
//   t        the fact text
//   cls      knowledge_class (default 'project_fact' -> lands in the
//            task-relevant bucket; only the cross-class category mixes classes)
//   ft       fact_type (default 'reference')
//   trust    trust_score 0..1 (default 0.8)
//   ageDays  age in days used for created_at/last_accessed_at (default 30)
//   state    knowledge_state (default 'trusted'; every candidate must be
//            'trusted' to be eligible for relevantKnowledge)
//
// Case shape: { id, category, query, corpus: [fact...], expected: [key...] }
//   expected is the ideal ranking of the RELEVANT keys (usually one).
//
// Authoring rules enforced at load time (see retrieval-dataset.mjs):
//   - paraphrase: query has ZERO content-token overlap with the TARGET fact
//   - distractor-resistance: >= 5 distractors, each sharing >=1 surface token
//     with the query
//   - every expected key exists in its corpus; every corpus has >= 2 facts
//
// Content is deliberately spread across many unrelated domains (devops,
// cooking, travel, clinic scheduling, personal finance, hardware, gardening,
// music, sports, legal/admin, HR, retail, education, transit, publishing) so
// cases are materially distinct, not one template with a swapped noun.

const f = (k, t, extra = {}) => ({ k, t, ...extra });

// ---------------------------------------------------------------------------
// 1. EXACT-TERM — the query shares salient exact tokens with the target; the
// distractors are on-domain-adjacent but do not share the discriminating term.
// Both the system and the grep baseline should handle these well; this is the
// "floor" category that proves neither ranker is broken on the easy case.
// ---------------------------------------------------------------------------
const exactTerm = [
  {
    id: 'ex-01', category: 'exact-term', query: 'which postgres version runs in production',
    corpus: [
      f('a', 'The production database runs PostgreSQL 16.2 on the primary cluster.'),
      f('b', 'Nightly backups are uploaded to the archive bucket at 02:00 UTC.'),
      f('c', 'The staging environment mirrors production traffic at ten percent.'),
      f('d', 'Frontend assets are served from the edge cache in three regions.'),
      f('e', 'The on-call rotation covers weekends in twelve hour shifts.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-02', category: 'exact-term', query: 'what temperature to roast the chicken',
    corpus: [
      f('a', 'Roast the whole chicken at 220 degrees Celsius for ninety minutes.'),
      f('b', 'Let the meat rest under foil for fifteen minutes before carving.'),
      f('c', 'Brine the bird overnight in salted water for juicier results.'),
      f('d', 'Serve the roast with rosemary potatoes and a green salad.'),
      f('e', 'A meat thermometer should read seventy-four degrees at the thigh.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-03', category: 'exact-term', query: 'when is the tokyo flight departing',
    corpus: [
      f('a', 'The Tokyo flight departs from gate B12 at 6:40 in the morning.'),
      f('b', 'Checked luggage is limited to twenty-three kilograms per bag.'),
      f('c', 'The hotel in Shinjuku offers a late checkout until noon.'),
      f('d', 'A rail pass covers unlimited travel for seven consecutive days.'),
      f('e', 'The layover in Seoul lasts just under two hours.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-04', category: 'exact-term', query: 'dosage of amoxicillin for the patient',
    corpus: [
      f('a', 'The amoxicillin dosage is 500 milligrams taken three times daily.'),
      f('b', 'The patient is allergic to penicillin derivatives and sulfa drugs.'),
      f('c', 'Follow-up bloodwork is scheduled for the second week of April.'),
      f('d', 'Blood pressure was recorded at 128 over 82 at the last visit.'),
      f('e', 'The clinic closes early on the final Friday of each month.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-05', category: 'exact-term', query: 'what is the mortgage interest rate',
    corpus: [
      f('a', 'The mortgage carries a fixed interest rate of 5.35 percent.'),
      f('b', 'Property tax is billed twice a year in equal instalments.'),
      f('c', 'The emergency fund holds roughly six months of expenses.'),
      f('d', 'The brokerage account rebalances automatically every quarter.'),
      f('e', 'Renters insurance was bundled with the auto policy for a discount.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-06', category: 'exact-term', query: 'how much ram does the laptop have',
    corpus: [
      f('a', 'The laptop ships with 32 gigabytes of RAM and a 1 terabyte drive.'),
      f('b', 'The docking station drives two external monitors over one cable.'),
      f('c', 'The keyboard backlight has three brightness levels.'),
      f('d', 'The warranty covers accidental damage for the first year.'),
      f('e', 'The webcam includes a physical privacy shutter.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-07', category: 'exact-term', query: 'when do the tomatoes need watering',
    corpus: [
      f('a', 'Water the tomatoes deeply every morning during the summer heat.'),
      f('b', 'Basil grows best in a sunny window away from cold drafts.'),
      f('c', 'The compost bin should be turned once a week for airflow.'),
      f('d', 'Slugs are kept off the lettuce with a ring of crushed shells.'),
      f('e', 'The raised beds were built from untreated cedar planks.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-08', category: 'exact-term', query: 'what key is the song in',
    corpus: [
      f('a', 'The song is written in the key of D minor at 92 beats per minute.'),
      f('b', 'The bridge modulates briefly before returning to the chorus.'),
      f('c', 'The demo was recorded on a single condenser microphone.'),
      f('d', 'The drummer prefers hickory sticks with a nylon tip.'),
      f('e', 'The album art was shot on black and white film.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-09', category: 'exact-term', query: 'what time is the basketball game',
    corpus: [
      f('a', 'The basketball game tips off at 7:30 on Saturday evening.'),
      f('b', 'Season tickets include priority parking in the north lot.'),
      f('c', 'The team retired the number twelve jersey last season.'),
      f('d', 'Concession stands stop serving at the start of the fourth quarter.'),
      f('e', 'The mascot leads a halftime routine with the dance squad.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-10', category: 'exact-term', query: 'deadline to file the trademark application',
    corpus: [
      f('a', 'The trademark application must be filed before the 30th of June.'),
      f('b', 'The registered agent forwards legal notices within two days.'),
      f('c', 'The partnership agreement is reviewed every fiscal year.'),
      f('d', 'Board minutes are archived in the shared compliance folder.'),
      f('e', 'The annual report fee is waived for the first year of operation.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-11', category: 'exact-term', query: 'how many vacation days are accrued',
    corpus: [
      f('a', 'Employees accrue twenty vacation days per year after probation.'),
      f('b', 'The parental leave policy grants sixteen paid weeks.'),
      f('c', 'Expense reports are due by the fifth of the following month.'),
      f('d', 'The office recycles electronics through a certified vendor.'),
      f('e', 'New hires complete security training in the first week.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-12', category: 'exact-term', query: 'what is the return window for the jacket',
    corpus: [
      f('a', 'The jacket can be returned within 45 days with the original tags.'),
      f('b', 'Loyalty points expire twelve months after they are earned.'),
      f('c', 'Gift cards are non-refundable but never expire.'),
      f('d', 'In-store pickup is usually ready within two hours.'),
      f('e', 'Free shipping applies to orders above fifty dollars.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-13', category: 'exact-term', query: 'which room is the chemistry exam in',
    corpus: [
      f('a', 'The chemistry exam is held in room 214 of the science building.'),
      f('b', 'Lab reports are submitted through the online portal by midnight.'),
      f('c', 'Office hours move to the library during exam week.'),
      f('d', 'Calculators are permitted only for the statistics module.'),
      f('e', 'The lecture recordings stay available for thirty days.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-14', category: 'exact-term', query: 'which platform does the express train leave from',
    corpus: [
      f('a', 'The express train leaves from platform 4 on weekday mornings.'),
      f('b', 'Monthly passes are cheaper than buying daily tickets.'),
      f('c', 'The last service of the night departs shortly after midnight.'),
      f('d', 'Bicycles are allowed in the rear carriage outside peak hours.'),
      f('e', 'The quiet coach is always the first behind the engine.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-15', category: 'exact-term', query: 'what font is used for the book body text',
    corpus: [
      f('a', 'The book body text is set in eleven point Garamond.'),
      f('b', 'Chapter headings use small caps with generous letter spacing.'),
      f('c', 'The index was compiled after the final page proofs.'),
      f('d', 'The cover stock is a matte laminate over heavy card.'),
      f('e', 'Footnotes appear at the foot of each page, not the chapter end.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-16', category: 'exact-term', query: 'what is the wifi password for the guest network',
    corpus: [
      f('a', 'The guest network wifi password is printed on the router label.'),
      f('b', 'The smart thermostat lowers the temperature at eleven at night.'),
      f('c', 'The garage door opener was paired with two remotes.'),
      f('d', 'The doorbell camera stores clips for fourteen days.'),
      f('e', 'The water heater is set to a maximum of sixty degrees.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-17', category: 'exact-term', query: 'what oil does the motorcycle take',
    corpus: [
      f('a', 'The motorcycle takes 10W-40 synthetic oil, about three litres.'),
      f('b', 'Tyre pressure should be checked before every long ride.'),
      f('c', 'The chain needs lubrication roughly every five hundred kilometres.'),
      f('d', 'The spare key is kept in the workshop drawer.'),
      f('e', 'The registration renewal falls due in September.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-18', category: 'exact-term', query: 'what is the api rate limit',
    corpus: [
      f('a', 'The public API rate limit is 600 requests per minute per key.'),
      f('b', 'Webhook payloads are signed with an HMAC SHA-256 header.'),
      f('c', 'The sandbox environment resets its data every night.'),
      f('d', 'Deprecated endpoints are removed after two release cycles.'),
      f('e', 'Pagination defaults to fifty records per page.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-19', category: 'exact-term', query: 'how long does the yoga class run',
    corpus: [
      f('a', 'The Tuesday yoga class runs for seventy-five minutes.'),
      f('b', 'Mats and blocks are provided free at the front desk.'),
      f('c', 'The sauna is reserved for members over eighteen.'),
      f('d', 'The pool closes for cleaning on the first Monday each month.'),
      f('e', 'Personal training sessions are booked a week in advance.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-20', category: 'exact-term', query: 'what is the ticket price for the museum',
    corpus: [
      f('a', 'The museum ticket price is eighteen dollars for adults.'),
      f('b', 'The rooftop terrace offers views across the harbour.'),
      f('c', 'Photography without flash is allowed in most galleries.'),
      f('d', 'The gift shop stocks prints of the permanent collection.'),
      f('e', 'Guided tours begin on the hour near the main staircase.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-21', category: 'exact-term', query: 'what resolution does the projector support',
    corpus: [
      f('a', 'The conference projector supports 4K resolution over HDMI.'),
      f('b', 'The room seats forty people in a horseshoe layout.'),
      f('c', 'The blinds are controlled from a panel by the door.'),
      f('d', 'A spare set of markers is kept in the credenza.'),
      f('e', 'The speakerphone pairs over Bluetooth in seconds.'),
    ],
    expected: ['a'],
  },
  {
    id: 'ex-22', category: 'exact-term', query: 'what breed is the neighbour dog',
    corpus: [
      f('a', 'The neighbour dog is a three-year-old border collie named Pip.'),
      f('b', 'The cat next door only comes out after dark.'),
      f('c', 'The community garden allows leashed pets on the path.'),
      f('d', 'The vet clinic on the corner opens at eight.'),
      f('e', 'The park has a fenced area for off-leash play.'),
    ],
    expected: ['a'],
  },
];

// ---------------------------------------------------------------------------
// 2. PARAPHRASE — the query restates the target using DIFFERENT content words
// (zero content-token overlap, enforced at load). Whole-token lexical signal is
// impossible by construction; only trigram character overlap could help, and
// across genuine synonyms that is thin. This category is expected to be WEAK
// offline and is flagged knownWeak (D2). Distractors are included so a
// zero-signal ranker cannot trivially guess the single relevant item.
// ---------------------------------------------------------------------------
const paraphrase = [
  {
    id: 'pp-01', category: 'paraphrase', query: 'how do I make the machine start over from scratch',
    corpus: [
      f('a', 'Hold the power button for ten seconds to reset the device fully.'),
      f('b', 'The screen brightness dims automatically in low light.'),
      f('c', 'Firmware updates arrive over the air each quarter.'),
      f('d', 'The carrying case includes a slot for the charger.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-02', category: 'paraphrase', query: 'where should everyone assemble if a fire breaks out',
    corpus: [
      f('a', 'The emergency muster point is the car park across the street.'),
      f('b', 'Extinguishers are inspected on a yearly schedule.'),
      f('c', 'The alarm panel sits beside the main reception desk.'),
      f('d', 'Smoke detectors were replaced throughout last spring.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-03', category: 'paraphrase', query: 'what should I feed a friend who eats no animal products',
    corpus: [
      f('a', 'Serve the vegan guest the lentil stew and the coconut dessert.'),
      f('b', 'The dinner reservation is booked for eight o\'clock.'),
      f('c', 'The wine cellar keeps a steady temperature year round.'),
      f('d', 'The long table seats a dozen comfortably.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-04', category: 'paraphrase', query: 'how far in advance must I tell them I am leaving the job',
    corpus: [
      f('a', 'Resignation requires four weeks of written notice to your manager.'),
      f('b', 'The cafeteria introduced a new seasonal menu.'),
      f('c', 'Parking permits are renewed through the intranet.'),
      f('d', 'The gym membership discount applies to all staff.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-05', category: 'paraphrase', query: 'what is the quickest way to reach the airport early morning',
    corpus: [
      f('a', 'Take the first express coach at dawn; it arrives at the terminal fastest.'),
      f('b', 'The lounge serves breakfast until half past ten.'),
      f('c', 'Duty free prices are similar to the high street.'),
      f('d', 'The car park shuttle circles every fifteen minutes.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-06', category: 'paraphrase', query: 'how can I stop the plant from dying in winter',
    corpus: [
      f('a', 'Move the fern indoors and cut watering to keep it alive through the cold months.'),
      f('b', 'The greenhouse fans switch on above thirty degrees.'),
      f('c', 'The seed packets are sorted by planting month.'),
      f('d', 'The hose reel was mounted beside the shed.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-07', category: 'paraphrase', query: 'who do I contact when the software breaks after hours',
    corpus: [
      f('a', 'Page the on-call engineer through the incident hotline overnight.'),
      f('b', 'The wiki documents every deployment step in order.'),
      f('c', 'Release notes are published on the first of the month.'),
      f('d', 'The design system uses a shared component library.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-08', category: 'paraphrase', query: 'how much money can I spend before needing approval',
    corpus: [
      f('a', 'Any purchase above two thousand dollars requires sign-off from finance.'),
      f('b', 'The travel booking tool suggests the cheapest fares first.'),
      f('c', 'Team offsites happen twice a year.'),
      f('d', 'The stationery cupboard is restocked on Fridays.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-09', category: 'paraphrase', query: 'what should I wear to the evening celebration',
    corpus: [
      f('a', 'The gala calls for formal attire, so pack a tuxedo or a long dress.'),
      f('b', 'The venue is a short walk from the station.'),
      f('c', 'Dinner is a plated three-course meal.'),
      f('d', 'A jazz trio plays after the speeches.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-10', category: 'paraphrase', query: 'how do I keep my account from being broken into',
    corpus: [
      f('a', 'Turn on two-factor login and pick a long unique passphrase for safety.'),
      f('b', 'The mobile app supports fingerprint sign-in.'),
      f('c', 'Statements are delivered as monthly PDFs.'),
      f('d', 'The branch on Elm Street relocated last year.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-11', category: 'paraphrase', query: 'what is the biggest weight the shelf can hold',
    corpus: [
      f('a', 'Each bracket is rated to bear up to twenty kilograms safely.'),
      f('b', 'The finish is a hard-wearing satin lacquer.'),
      f('c', 'Assembly needs only a single hex tool.'),
      f('d', 'The flat pack fits in most car boots.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-12', category: 'paraphrase', query: 'when does the shop open its doors on the weekend',
    corpus: [
      f('a', 'On Saturday and Sunday the store begins trading at nine in the morning.'),
      f('b', 'The loyalty scheme rewards frequent visits.'),
      f('c', 'The bakery counter sells out by lunchtime.'),
      f('d', 'Delivery slots can be reserved a week ahead.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-13', category: 'paraphrase', query: 'how do I lower my monthly outgoings',
    corpus: [
      f('a', 'Cancel unused subscriptions and switch to a cheaper energy tariff to cut spending.'),
      f('b', 'The credit card offers cashback on groceries.'),
      f('c', 'Payday falls on the last working day.'),
      f('d', 'The pension contribution matches up to five percent.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-14', category: 'paraphrase', query: 'what is the rule about bringing pets inside',
    corpus: [
      f('a', 'Only assistance animals are permitted beyond the lobby.'),
      f('b', 'The elevator is out of service until Thursday.'),
      f('c', 'Recycling is collected on alternate weeks.'),
      f('d', 'The rooftop garden is open until dusk.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-15', category: 'paraphrase', query: 'how long before the medicine starts working',
    corpus: [
      f('a', 'Relief usually begins within half an hour of swallowing the tablet.'),
      f('b', 'Store the bottle away from direct sunlight.'),
      f('c', 'The pharmacy delivers to your door on request.'),
      f('d', 'A repeat prescription lasts for six cycles.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-16', category: 'paraphrase', query: 'what happens to my files if the laptop is stolen',
    corpus: [
      f('a', 'Full-disk encryption keeps your documents unreadable to a thief.'),
      f('b', 'The trackpad gestures can be customised in settings.'),
      f('c', 'The battery lasts about twelve hours of light use.'),
      f('d', 'The hinge is rated for many thousands of openings.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-17', category: 'paraphrase', query: 'how do I get a refund for a trip I can no longer take',
    corpus: [
      f('a', 'Cancel the booking before departure to reclaim the fare, minus a small fee.'),
      f('b', 'Seat selection opens a day ahead of the journey.'),
      f('c', 'The buffet car accepts contactless payment.'),
      f('d', 'Children under five travel without a ticket.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-18', category: 'paraphrase', query: 'what should students bring to sit the test',
    corpus: [
      f('a', 'Candidates must carry photo identification and two dark pencils into the hall.'),
      f('b', 'The canteen serves a set lunch on weekdays.'),
      f('c', 'The library extends its hours near the end of term.'),
      f('d', 'Cycling proficiency is offered each spring.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-19', category: 'paraphrase', query: 'how do I make the recording louder overall',
    corpus: [
      f('a', 'Raise the master gain and apply gentle compression to lift the whole mix.'),
      f('b', 'The studio books out weeks in advance.'),
      f('c', 'The vinyl pressing has a warm low end.'),
      f('d', 'The lyric sheet is tucked inside the sleeve.'),
    ],
    expected: ['a'],
  },
  {
    id: 'pp-20', category: 'paraphrase', query: 'what do I do with leftover paint after decorating',
    corpus: [
      f('a', 'Seal the tin tightly and drop it at the household hazardous waste depot.'),
      f('b', 'A roller covers walls faster than a brush.'),
      f('c', 'Masking tape peels cleanest while the surface is warm.'),
      f('d', 'Two coats give the richest colour.'),
    ],
    expected: ['a'],
  },
];

// ---------------------------------------------------------------------------
// 3. DISTRACTOR-RESISTANCE — >= 5 distractors that repeat a COMMON query token
// (inflating a raw exact-overlap / grep score) while missing the discriminating
// term or intent. The target holds the rare discriminating term. IDF-aware FTS
// plus semantic + trust signal should prefer the target; the multiplicity-
// counting grep baseline is drawn toward the repetitive distractors. This is
// where the system is expected to open a clear margin over the baseline.
// ---------------------------------------------------------------------------
const distractor = [
  {
    id: 'dr-01', category: 'distractor-resistance', query: 'how do I reset my two-factor authentication',
    corpus: [
      f('a', 'To reset two-factor authentication, revoke the old device under account security.'),
      f('b', 'The authentication service logs every authentication attempt for authentication auditing.'),
      f('c', 'Authentication tokens for the authentication gateway rotate on an authentication schedule.'),
      f('d', 'The authentication team owns the authentication microservice and its authentication docs.'),
      f('e', 'Single sign-on authentication federates authentication across authentication providers.'),
      f('f', 'Authentication latency is tracked on the authentication dashboard hourly.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-02', category: 'distractor-resistance', query: 'where do I change my shipping address',
    corpus: [
      f('a', 'Update your shipping address under the delivery preferences in your profile.'),
      f('b', 'The shipping label prints from the shipping desk near the shipping dock.'),
      f('c', 'Shipping costs depend on the shipping zone and the shipping speed chosen.'),
      f('d', 'The shipping carrier scans each shipping barcode at the shipping hub.'),
      f('e', 'Shipping insurance covers the shipping value up to the shipping limit.'),
      f('f', 'Shipping delays are posted on the shipping status page during shipping peaks.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-03', category: 'distractor-resistance', query: 'what is the checkout time at the hotel',
    corpus: [
      f('a', 'Guests must vacate the room by 11 a.m., the standard departure time.'),
      f('b', 'The hotel gym, hotel spa, and hotel pool share the hotel wristband.'),
      f('c', 'Hotel parking is billed per night at the hotel front desk.'),
      f('d', 'The hotel shuttle loops between the hotel and the hotel conference annex.'),
      f('e', 'Hotel breakfast is served in the hotel atrium beside the hotel lounge.'),
      f('f', 'Hotel loyalty points post to the hotel account after each hotel stay.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-04', category: 'distractor-resistance', query: 'how do I lower the oven temperature for baking',
    corpus: [
      f('a', 'Turn the thermostat dial anticlockwise to drop the heat before baking delicate pastry.'),
      f('b', 'The oven light, oven timer, and oven fan share one oven control panel.'),
      f('c', 'Oven cleaning uses an oven-safe spray on a cool oven surface.'),
      f('d', 'The oven racks slide into oven grooves at three oven heights.'),
      f('e', 'Oven preheating for the oven grill takes the oven several minutes.'),
      f('f', 'The oven door seal keeps oven heat inside the oven cavity.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-05', category: 'distractor-resistance', query: 'how do I cancel a recurring payment',
    corpus: [
      f('a', 'Stop a recurring charge by removing the mandate under standing instructions.'),
      f('b', 'The payment gateway routes each payment to the payment processor for payment capture.'),
      f('c', 'Payment receipts email after every payment via the payment notifier.'),
      f('d', 'Payment disputes open a payment case in the payment resolution queue.'),
      f('e', 'Payment fees vary by payment method and payment currency.'),
      f('f', 'The payment ledger reconciles payment totals against payment settlements nightly.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-06', category: 'distractor-resistance', query: 'when is the next backup scheduled to run',
    corpus: [
      f('a', 'The next snapshot kicks off at 02:00 UTC as the recurring overnight job.'),
      f('b', 'The backup vault stores backup copies across backup regions for backup durability.'),
      f('c', 'Backup encryption wraps each backup blob with a backup key.'),
      f('d', 'Backup restore drills verify backup integrity from the backup catalogue.'),
      f('e', 'Backup retention keeps daily backups for a backup window of thirty days.'),
      f('f', 'Backup alerts fire when a backup lags behind the backup schedule.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-07', category: 'distractor-resistance', query: 'how do I book a meeting room',
    corpus: [
      f('a', 'Reserve a room through the calendar add-in and pick an available slot.'),
      f('b', 'The meeting notes, meeting agenda, and meeting recap live in the meeting folder.'),
      f('c', 'Meeting invites from the meeting organiser reach every meeting attendee.'),
      f('d', 'The meeting screen mirrors the meeting laptop over the meeting cable.'),
      f('e', 'Meeting minutes summarise each meeting decision for the meeting record.'),
      f('f', 'Meeting reminders ping the meeting chat before the meeting starts.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-08', category: 'distractor-resistance', query: 'what antibiotic was prescribed for the infection',
    corpus: [
      f('a', 'The clinician started the patient on doxycycline for the skin infection.'),
      f('b', 'The infection ward tracks infection rates on the infection board.'),
      f('c', 'Infection control audits infection risk at every infection checkpoint.'),
      f('d', 'Infection signage reminds staff about infection hygiene during infection season.'),
      f('e', 'The infection log records each infection swab and infection result.'),
      f('f', 'Infection outbreaks trigger an infection review by the infection committee.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-09', category: 'distractor-resistance', query: 'how do I renew my library membership',
    corpus: [
      f('a', 'Extend your membership at the front counter or through the account portal.'),
      f('b', 'The library catalogue, library archive, and library atlas sit on the library intranet.'),
      f('c', 'Library fines accrue on library loans past the library due date.'),
      f('d', 'Library study rooms book through the library kiosk near the library entrance.'),
      f('e', 'Library newsletters list library events and library workshops each library term.'),
      f('f', 'Library staff shelve library returns in the library sorting bay.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-10', category: 'distractor-resistance', query: 'how do I change the delivery date for my order',
    corpus: [
      f('a', 'Reschedule the drop-off by picking a new day in the tracking link.'),
      f('b', 'The order summary, order history, and order receipt open from the order page.'),
      f('c', 'Order packing scans each order item against the order manifest.'),
      f('d', 'Order cancellations release the order hold on the order total.'),
      f('e', 'Order notifications text the order status after every order update.'),
      f('f', 'Order returns generate an order label from the order desk.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-11', category: 'distractor-resistance', query: 'how do I mute notification alerts during a call',
    corpus: [
      f('a', 'Enable do-not-disturb from the status menu to silence alerts while talking.'),
      f('b', 'The notification centre groups notification badges by notification source.'),
      f('c', 'Notification sounds for each notification channel share a notification profile.'),
      f('d', 'Notification history keeps every notification for a notification week.'),
      f('e', 'Notification permissions gate which apps push a notification banner.'),
      f('f', 'Notification previews on the lock screen hide notification content.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-12', category: 'distractor-resistance', query: 'where do I submit an expense claim',
    corpus: [
      f('a', 'Submit each claim in the finance portal under the reimbursements tab.'),
      f('b', 'The expense card, expense log, and expense report feed the expense system.'),
      f('c', 'Expense limits per expense category appear in the expense policy.'),
      f('d', 'Expense approvals route each expense line to an expense reviewer.'),
      f('e', 'Expense receipts attach to the expense entry in the expense app.'),
      f('f', 'Expense audits sample expense claims against expense rules.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-13', category: 'distractor-resistance', query: 'how do I water the orchid correctly',
    corpus: [
      f('a', 'Soak the roots weekly, then let the pot drain fully so it never sits wet.'),
      f('b', 'The garden hose, garden rake, and garden shears hang in the garden shed.'),
      f('c', 'Garden beds along the garden path get garden mulch each garden season.'),
      f('d', 'Garden pests near the garden fence face a garden trap.'),
      f('e', 'Garden compost from the garden bin feeds the garden soil.'),
      f('f', 'Garden lights line the garden steps for garden evenings.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-14', category: 'distractor-resistance', query: 'how do I transfer money to a savings account',
    corpus: [
      f('a', 'Move funds between your own accounts using the internal transfer option.'),
      f('b', 'The account dashboard, account statement, and account alerts share the account view.'),
      f('c', 'Account fees on each account tier list in the account terms.'),
      f('d', 'Account recovery verifies the account owner before account access.'),
      f('e', 'Account nicknames label each account in the account list.'),
      f('f', 'Account closure archives the account record in the account vault.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-15', category: 'distractor-resistance', query: 'how do I skip a track on the playlist',
    corpus: [
      f('a', 'Tap the forward arrow twice to jump past the current song.'),
      f('b', 'The playlist queue, playlist cover, and playlist name edit on the playlist screen.'),
      f('c', 'Playlist sharing sends a playlist link to a playlist follower.'),
      f('d', 'Playlist shuffle reorders the playlist songs on each playlist play.'),
      f('e', 'Playlist downloads cache the playlist for playlist offline use.'),
      f('f', 'Playlist recommendations grow the playlist from playlist history.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-16', category: 'distractor-resistance', query: 'how do I defrost the freezer safely',
    corpus: [
      f('a', 'Unplug the unit, lay down towels, and let the ice melt on its own.'),
      f('b', 'The freezer drawer, freezer light, and freezer seal are freezer parts.'),
      f('c', 'Freezer temperature on the freezer dial keeps freezer food frozen.'),
      f('d', 'Freezer bags label freezer batches for freezer rotation.'),
      f('e', 'Freezer frost builds when the freezer door leaks freezer air.'),
      f('f', 'Freezer alarms warn when the freezer warms above freezer limits.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-17', category: 'distractor-resistance', query: 'how do I dispute a charge on my card',
    corpus: [
      f('a', 'Flag the charge as unauthorised and the bank opens an investigation.'),
      f('b', 'The card reader, card sleeve, and card app all show the card balance.'),
      f('c', 'Card limits on each card tier appear in the card agreement.'),
      f('d', 'Card replacement ships a new card to the card address.'),
      f('e', 'Card rewards credit the card after each card purchase.'),
      f('f', 'Card freezing locks the card from the card menu.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-18', category: 'distractor-resistance', query: 'how do I change my seat on the plane',
    corpus: [
      f('a', 'Pick a different spot from the seat map in the manage-booking area.'),
      f('b', 'The flight crew, flight deck, and flight log belong to the flight team.'),
      f('c', 'Flight delays push the flight time on the flight board.'),
      f('d', 'Flight meals on the flight menu suit each flight class.'),
      f('e', 'Flight points post to the flight account after the flight lands.'),
      f('f', 'Flight alerts text the flight gate before the flight boards.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-19', category: 'distractor-resistance', query: 'how do I update the firmware on the router',
    corpus: [
      f('a', 'Flash the newest firmware image from the admin page under system tools.'),
      f('b', 'The router antenna, router port, and router light are router hardware.'),
      f('c', 'Router settings on the router menu save to the router memory.'),
      f('d', 'Router logs record each router reboot and router error.'),
      f('e', 'Router bands split the router signal across router channels.'),
      f('f', 'Router security on the router firewall blocks router intrusions.'),
    ],
    expected: ['a'],
  },
  {
    id: 'dr-20', category: 'distractor-resistance', query: 'how do I export my calendar to a file',
    corpus: [
      f('a', 'Download an ICS copy from the settings menu to save your schedule.'),
      f('b', 'The calendar view, calendar grid, and calendar sidebar share the calendar layout.'),
      f('c', 'Calendar events on the calendar feed sync to the calendar app.'),
      f('d', 'Calendar colours tag each calendar entry by calendar category.'),
      f('e', 'Calendar invites from the calendar owner reach every calendar guest.'),
      f('f', 'Calendar reminders ping the calendar bar before a calendar event.'),
    ],
    expected: ['a'],
  },
];

// ---------------------------------------------------------------------------
// 4. CROSS-CLASS RANKING — the correct answer is the fact whose CLASS matches
// the query's intent, and CLASS is the ONLY signal that surfaces it. Every case
// is built as an adversarial trap for a content-only ranker:
//
//   - the target is the SOLE trusted-core-class fact (identity / constraint /
//     preference) in its corpus, and it deliberately carries LOW query
//     content-token overlap — it paraphrases the answer with different words;
//   - a same-topic `project_fact` "trap" distractor echoes the query's salient
//     tokens repeatedly, so it has STRICTLY HIGHER content/embedding overlap
//     than the target;
//   - the remaining distractors are project_fact / episodic_fact (never a
//     trusted-core class), so the target is alone in the trusted-core bucket.
//
// buildMemoryContext partitions candidates into a trusted-core bucket
// (identity / constraint / preference) that is emitted AHEAD of the
// task-relevant bucket (project_fact / episodic_fact), so the lone trusted-core
// target is ranked #1 regardless of content score. A content-only cosine ranker
// (no class logic) must rank the higher-overlap project_fact trap first and
// pushes the target down — so this category fails for any ranker that ignores
// class, which is exactly what it is meant to gate. The grep baseline, blind to
// class, is likewise defeated. Ground truth is the class-appropriate fact.
// ---------------------------------------------------------------------------
const crossClass = [
  {
    id: 'cc-01', category: 'cross-class', query: 'what is the hard rule about deploying on fridays',
    corpus: [
      f('a', 'Shipping to production near the close of the working week is strictly prohibited.', { cls: 'constraint', ft: 'constraint', trust: 0.9 }),
      f('b', 'The deploy calendar highlights every Friday deploy window and each Friday deploy freeze.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Version tags are written to the registry automatically after each build.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'A hotfix went out last Friday afternoon without any incident.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 5 }),
      f('e', 'The pipeline runs smoke tests before promoting a candidate build.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'The rollback playbook lives in the operations wiki.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-02', category: 'cross-class', query: 'who is the primary account owner',
    corpus: [
      f('a', 'Dana Ruiz, the founding director, holds ultimate responsibility for the organisation.', { cls: 'identity', ft: 'entity', trust: 0.95 }),
      f('b', 'The account settings list the primary account owner and every secondary account owner.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Permissions can be edited on the roles administration page.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'Dana approved a budget increase during the spring review.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 20 }),
      f('e', 'New members are added through the invitations panel.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Seats renew on the annual billing anniversary.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-03', category: 'cross-class', query: 'what does the user prefer for meeting scheduling',
    corpus: [
      f('a', 'Afternoons work best; anything before ten in the morning should be declined.', { cls: 'preference', ft: 'preference', trust: 0.9 }),
      f('b', 'The scheduling tool syncs each meeting and lists every meeting the user chose to schedule.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Rooms are reserved through the front desk.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'A slot was booked at nine last Tuesday by mistake.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 7 }),
      f('e', 'Invites are sent to all attendees automatically.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'The shared calendar colour-codes each team.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-04', category: 'cross-class', query: 'what is the compliance limit on data retention',
    corpus: [
      f('a', 'Personal records must be erased once ninety days have elapsed, by regulation.', { cls: 'constraint', ft: 'constraint', trust: 0.95 }),
      f('b', 'The data retention report tracks each data retention window against the data retention limit.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Events are archived to cold storage each night.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'Old logs were kept for an audit back in March.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 120 }),
      f('e', 'The warehouse refreshes its tables overnight.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Ingestion jobs are monitored on the pipeline board.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-05', category: 'cross-class', query: 'who is the lead physician on this case',
    corpus: [
      f('a', 'Dr. Osei carries clinical responsibility for the patient throughout treatment.', { cls: 'identity', ft: 'entity', trust: 0.95 }),
      f('b', 'The case board names the lead physician and every consulting physician on the case.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'The care plan is stored in the record system.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'A scan was ordered during the Tuesday ward round.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 3 }),
      f('e', 'The ward holds twenty beds across two bays.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Visiting hours run from noon until eight.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-06', category: 'cross-class', query: 'what dietary preference should the kitchen follow',
    corpus: [
      f('a', 'The household eats strictly vegetarian and never touches fish or meat.', { cls: 'preference', ft: 'preference', trust: 0.9 }),
      f('b', 'The kitchen board lists each dietary preference and how the kitchen should follow every dietary note.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'The pantry inventory is tracked on a whiteboard.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'A seafood platter was ordered for the party last summer.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 200 }),
      f('e', 'The oven was serviced in the autumn.', { cls: 'episodic_fact', ft: 'reference', trust: 0.6, ageDays: 150 }),
      f('g', 'Grocery orders arrive every Thursday morning.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-07', category: 'cross-class', query: 'what is the non-negotiable safety requirement on site',
    corpus: [
      f('a', 'Hard hats must be worn everywhere on the grounds, without exception.', { cls: 'constraint', ft: 'constraint', trust: 0.95 }),
      f('b', 'The safety board lists each site safety requirement and every site safety inspection.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'The office keeps spare gear in a locker.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'A visitor forgot protective equipment during last week tour.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 8 }),
      f('e', 'The crane log is reviewed each morning.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Deliveries enter through the north gate only.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-08', category: 'cross-class', query: 'who owns the billing relationship for this client',
    corpus: [
      f('a', 'Priya Nair is the named contact who manages this customer account.', { cls: 'identity', ft: 'entity', trust: 0.95 }),
      f('b', 'The billing portal shows the client billing history and every client billing invoice.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Invoices are generated on the first of each month.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'A billing correction was raised after the last cycle.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 15 }),
      f('e', 'The ledger export runs nightly.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Statements are delivered as monthly PDFs.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-09', category: 'cross-class', query: 'what coding standard must every pull request follow',
    corpus: [
      f('a', 'No change may merge unless the linter reports zero warnings.', { cls: 'constraint', ft: 'constraint', trust: 0.9 }),
      f('b', 'The standards page documents the coding standard every pull request must follow before a pull request merges.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'The CI pipeline runs on every push to a branch.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'A change was merged last night that skipped the gate.', { cls: 'episodic_fact', ft: 'decision', trust: 0.55, ageDays: 2 }),
      f('e', 'The repository uses trunk-based development.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Draft branches are cleaned up after two weeks.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-10', category: 'cross-class', query: 'what is the customer standing communication preference',
    corpus: [
      f('a', 'Reach out only by email; phone calls are unwelcome.', { cls: 'preference', ft: 'preference', trust: 0.9 }),
      f('b', 'The customer profile records each customer communication and the customer communication channel.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Support tickets are triaged within one business day.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'We phoned the customer once during a January outage.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 180 }),
      f('e', 'The referral programme awards account credit.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Surveys are sent quarterly to active accounts.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-11', category: 'cross-class', query: 'who is the emergency contact for the student',
    corpus: [
      f('a', 'The pupil aunt, Mara Feld, should be reached first if anything happens.', { cls: 'identity', ft: 'entity', trust: 0.95 }),
      f('b', 'The student record lists the emergency contact and every emergency contact update for the student.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Attendance is recorded twice each school day.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'Mara collected the pupil early one day last term.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 40 }),
      f('e', 'The choir meets on Wednesday afternoons.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Report cards are issued at the end of term.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-12', category: 'cross-class', query: 'what is the firm limit on withdrawal amounts',
    corpus: [
      f('a', 'No more than one thousand dollars in cash may be taken out each day, by policy.', { cls: 'constraint', ft: 'constraint', trust: 0.9 }),
      f('b', 'The withdrawal report totals each withdrawal amount against the daily withdrawal ceiling.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'ATMs dispense notes in fifties and twenties.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'A large cash removal was flagged for review in December.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 210 }),
      f('e', 'The app shows the balance in real time.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Branch counters close at four on weekdays.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-13', category: 'cross-class', query: 'what accessibility preference does the reader have',
    corpus: [
      f('a', 'Dark mode with a large, high-contrast typeface is what they like best.', { cls: 'preference', ft: 'preference', trust: 0.9 }),
      f('b', 'The reader settings store each accessibility preference and sync the reader accessibility profile.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'The app remembers the last opened chapter.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'They switched to light mode once to print a page.', { cls: 'episodic_fact', ft: 'decision', trust: 0.55, ageDays: 12 }),
      f('e', 'The library syncs across devices overnight.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Bookmarks export as a plain list.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-14', category: 'cross-class', query: 'who is the registered legal representative',
    corpus: [
      f('a', 'The solicitor of record is Ken Abara, who acts on the firm behalf.', { cls: 'identity', ft: 'entity', trust: 0.95 }),
      f('b', 'The legal directory lists the registered representative and each registered legal filing.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Case files are stored in the sealed records room.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'Ken filed a motion during the spring hearing.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 70 }),
      f('e', 'Hearings are scheduled through the court clerk.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Exhibits are numbered as they are entered.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-15', category: 'cross-class', query: 'what is the absolute rule about sharing keys',
    corpus: [
      f('a', 'Production credentials must never travel over chat, a firm security requirement.', { cls: 'constraint', ft: 'constraint', trust: 0.95 }),
      f('b', 'The key registry logs each shared key and every rule about sharing a key.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Secrets live in the managed vault service.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'Someone pasted a test token in the channel once by accident.', { cls: 'episodic_fact', ft: 'decision', trust: 0.55, ageDays: 6 }),
      f('e', 'The vault rotates its entries on a fixed cadence.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Access grants are reviewed each quarter.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-16', category: 'cross-class', query: 'what seating preference does the traveller keep',
    corpus: [
      f('a', 'A window spot near the front of the cabin is always the choice.', { cls: 'preference', ft: 'preference', trust: 0.9 }),
      f('b', 'The traveller profile saves each seating preference and the traveller seating history.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Boarding groups are called by row from the back.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'An aisle spot was taken once when the flight was full.', { cls: 'episodic_fact', ft: 'decision', trust: 0.55, ageDays: 45 }),
      f('e', 'The lounge is on the upper concourse.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Baggage tags print at the kiosk.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-17', category: 'cross-class', query: 'who is the designated fire warden for the floor',
    corpus: [
      f('a', 'Tom Beck takes charge of evacuations on the third level of the building.', { cls: 'identity', ft: 'entity', trust: 0.95 }),
      f('b', 'The floor plan marks each fire warden station and every fire warden on the floor.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Exits are marked with green running-man signs.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'Tom ran the last evacuation drill in autumn.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 55 }),
      f('e', 'Extinguishers are inspected every year.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'The assembly point is the car park across the road.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-18', category: 'cross-class', query: 'what is the mandatory review step before release',
    corpus: [
      f('a', 'Nothing may ship publicly until a security sign-off is complete, no exceptions.', { cls: 'constraint', ft: 'constraint', trust: 0.9 }),
      f('b', 'The release checklist lists each mandatory review and every release review step.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Notes are drafted in the shared document.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'A patch shipped skipping review during an incident.', { cls: 'episodic_fact', ft: 'decision', trust: 0.55, ageDays: 4 }),
      f('e', 'Versions follow semantic numbering.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Feature flags gate anything not yet announced.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-19', category: 'cross-class', query: 'who is the primary maintainer of the payments library',
    corpus: [
      f('a', 'Ivo Sanchez owns and stewards that billing module day to day.', { cls: 'identity', ft: 'entity', trust: 0.95 }),
      f('b', 'The payments library page names the primary maintainer and each payments library contributor.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'The module ships as a versioned package.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'Ivo merged a fix during the last sprint.', { cls: 'episodic_fact', ft: 'decision', trust: 0.6, ageDays: 10 }),
      f('e', 'Contributors squash their commits before merging.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Release candidates are tagged on the main branch.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
  {
    id: 'cc-20', category: 'cross-class', query: 'what is the strict rule about handling patient records',
    corpus: [
      f('a', 'Clinical files may never leave the secure network, an absolute requirement.', { cls: 'constraint', ft: 'constraint', trust: 0.95 }),
      f('b', 'The records system indexes each patient record and logs every patient record handling event.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('c', 'Files are backed up to the encrypted archive nightly.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('d', 'A record was exported to a laptop during an audit last year.', { cls: 'episodic_fact', ft: 'decision', trust: 0.55, ageDays: 250 }),
      f('e', 'Access is logged against a unique identifier.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
      f('g', 'Charts are printed only at the ward station.', { cls: 'project_fact', ft: 'reference', trust: 0.7 }),
    ],
    expected: ['a'],
  },
];

// ---------------------------------------------------------------------------
// 5. TRUST-VS-RECENCY — two candidate facts share the query's tokens equally,
// so lexical/semantic signal is roughly tied and the ranking must be decided by
// trust_score vs recency. Half the cases the correct answer is the older,
// high-trust authoritative fact (trust should win); half the correct answer is
// the recent fact that reflects the current state (recency should win). Ground
// truth is the scenario-correct fact; the grep baseline, blind to both trust
// and recency, is expected to be at chance here.
// ---------------------------------------------------------------------------
const trustRecency = [
  // --- TRUST SHOULD WIN: an old, high-trust authoritative fact vs a recent,
  // low-trust claim. Both facts carry EXACTLY the query's content tokens, so
  // lexical/semantic signal ties and only trust (and recency) can decide. The
  // authoritative (high-trust) value is correct. The grep baseline, blind to
  // trust, is left at chance by the tie. ---
  {
    id: 'tr-01', category: 'trust-vs-recency', query: 'what is the official server password minimum length',
    corpus: [
      f('a', 'The official server password minimum length is fixed at sixteen.', { trust: 0.97, ageDays: 150 }),
      f('b', 'The official server password minimum length is fixed at eight.', { trust: 0.33, ageDays: 2 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-02', category: 'trust-vs-recency', query: 'what is the approved company travel budget per trip',
    corpus: [
      f('a', 'The approved company travel budget per trip equals fifteen hundred dollars.', { trust: 0.95, ageDays: 120 }),
      f('b', 'The approved company travel budget per trip equals four thousand dollars.', { trust: 0.3, ageDays: 1 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-03', category: 'trust-vs-recency', query: 'what is the verified sensor calibration offset value',
    corpus: [
      f('a', 'The verified sensor calibration offset value reads zero point zero two.', { trust: 0.96, ageDays: 200 }),
      f('b', 'The verified sensor calibration offset value reads zero point nine one.', { trust: 0.3, ageDays: 3 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-04', category: 'trust-vs-recency', query: 'what is the confirmed building occupancy capacity limit',
    corpus: [
      f('a', 'The confirmed building occupancy capacity limit stands at three hundred.', { trust: 0.97, ageDays: 180 }),
      f('b', 'The confirmed building occupancy capacity limit stands at nine hundred.', { trust: 0.3, ageDays: 2 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-05', category: 'trust-vs-recency', query: 'what is the certified bridge load tolerance rating',
    corpus: [
      f('a', 'The certified bridge load tolerance rating measures forty tonnes.', { trust: 0.97, ageDays: 220 }),
      f('b', 'The certified bridge load tolerance rating measures ninety tonnes.', { trust: 0.3, ageDays: 1 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-06', category: 'trust-vs-recency', query: 'what is the audited annual donation total figure',
    corpus: [
      f('a', 'The audited annual donation total figure came to ninety thousand.', { trust: 0.96, ageDays: 160 }),
      f('b', 'The audited annual donation total figure came to three million.', { trust: 0.3, ageDays: 2 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-07', category: 'trust-vs-recency', query: 'what is the validated sample storage temperature setting',
    corpus: [
      f('a', 'The validated sample storage temperature setting holds minus eighty.', { trust: 0.97, ageDays: 140 }),
      f('b', 'The validated sample storage temperature setting holds minus twenty.', { trust: 0.3, ageDays: 3 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-08', category: 'trust-vs-recency', query: 'what is the ratified overtime pay rate multiplier',
    corpus: [
      f('a', 'The ratified overtime pay rate multiplier works out to one point five.', { trust: 0.96, ageDays: 130 }),
      f('b', 'The ratified overtime pay rate multiplier works out to three point zero.', { trust: 0.3, ageDays: 1 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-09', category: 'trust-vs-recency', query: 'what is the certified elevator maximum load rating',
    corpus: [
      f('a', 'The certified elevator maximum load rating comes to one thousand kilograms.', { trust: 0.97, ageDays: 175 }),
      f('b', 'The certified elevator maximum load rating comes to five thousand kilograms.', { trust: 0.3, ageDays: 2 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-10', category: 'trust-vs-recency', query: 'what is the official passport photo size requirement',
    corpus: [
      f('a', 'The official passport photo size requirement specifies thirty-five millimetres.', { trust: 0.97, ageDays: 190 }),
      f('b', 'The official passport photo size requirement specifies fifty millimetres.', { trust: 0.3, ageDays: 3 }),
    ],
    expected: ['a'],
  },
  // --- RECENCY SHOULD WIN: the current state supersedes a stale value. Trust is
  // equal on both facts and both carry the query's content tokens, so only
  // recency can decide; the recent fact is correct. ---
  {
    id: 'tr-11', category: 'trust-vs-recency', query: 'where is the team office currently located',
    corpus: [
      f('a', 'The team office is currently located inside the Harbour Tower.', { trust: 0.8, ageDays: 3 }),
      f('b', 'The team office is currently located inside the Maple building.', { trust: 0.8, ageDays: 400 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-12', category: 'trust-vs-recency', query: 'what is the current active project deadline date',
    corpus: [
      f('a', 'The current active project deadline date moved to the fifteenth.', { trust: 0.8, ageDays: 2 }),
      f('b', 'The current active project deadline date moved to the thirtieth.', { trust: 0.8, ageDays: 250 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-13', category: 'trust-vs-recency', query: 'who is the current assigned on-call engineer',
    corpus: [
      f('a', 'The current assigned on-call engineer is now Sam Whitfield.', { trust: 0.8, ageDays: 1 }),
      f('b', 'The current assigned on-call engineer is now Lena Torres.', { trust: 0.8, ageDays: 60 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-14', category: 'trust-vs-recency', query: 'what is the latest released application version number',
    corpus: [
      f('a', 'The latest released application version number is currently five point two.', { trust: 0.8, ageDays: 2 }),
      f('b', 'The latest released application version number is currently four point eight.', { trust: 0.8, ageDays: 300 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-15', category: 'trust-vs-recency', query: 'what is the current standup meeting room assignment',
    corpus: [
      f('a', 'The current standup meeting room assignment points to the Birch space.', { trust: 0.8, ageDays: 1 }),
      f('b', 'The current standup meeting room assignment points to the Cedar space.', { trust: 0.8, ageDays: 120 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-16', category: 'trust-vs-recency', query: 'what is the present applicable currency exchange rate',
    corpus: [
      f('a', 'The present applicable currency exchange rate sits at one point one two.', { trust: 0.8, ageDays: 1 }),
      f('b', 'The present applicable currency exchange rate sits at one point zero five.', { trust: 0.8, ageDays: 90 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-17', category: 'trust-vs-recency', query: 'what is the updated store evening closing time',
    corpus: [
      f('a', 'The updated store evening closing time shifts to nine oclock.', { trust: 0.8, ageDays: 1 }),
      f('b', 'The updated store evening closing time shifts to six oclock.', { trust: 0.8, ageDays: 200 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-18', category: 'trust-vs-recency', query: 'which database host are we currently targeting',
    corpus: [
      f('a', 'We are currently targeting the database host at the eu-west replica.', { trust: 0.8, ageDays: 2 }),
      f('b', 'We are currently targeting the database host at the us-east primary.', { trust: 0.8, ageDays: 180 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-19', category: 'trust-vs-recency', query: 'what is the current assigned parking permit zone',
    corpus: [
      f('a', 'The current assigned parking permit zone changed to sector green.', { trust: 0.8, ageDays: 3 }),
      f('b', 'The current assigned parking permit zone changed to sector amber.', { trust: 0.8, ageDays: 220 }),
    ],
    expected: ['a'],
  },
  {
    id: 'tr-20', category: 'trust-vs-recency', query: 'what is the confirmed warehouse inventory reorder threshold',
    corpus: [
      f('a', 'The confirmed warehouse inventory reorder threshold updated to two hundred units.', { trust: 0.8, ageDays: 2 }),
      f('b', 'The confirmed warehouse inventory reorder threshold updated to fifty units.', { trust: 0.8, ageDays: 190 }),
    ],
    expected: ['a'],
  },
];

export const CATEGORIES = [
  'exact-term',
  'paraphrase',
  'distractor-resistance',
  'cross-class',
  'trust-vs-recency',
];

// Categories the offline tier (sqlite FTS + hashed-trigram local embeddings)
// is structurally weak at — flagged knownWeak in the report (D2). Paraphrase
// with zero content-token overlap cannot be solved by whole-token lexical
// matching and is only thinly reachable by trigram character overlap.
export const KNOWN_WEAK_CATEGORIES = new Set(['paraphrase']);

export const cases = [
  ...exactTerm,
  ...paraphrase,
  ...distractor,
  ...crossClass,
  ...trustRecency,
];
