const SERVICE_FAQS_BY_NAME = {
  'AC Jet + Water Service': [
    {
      question: 'What does AC jet and water service include?',
      answer: 'It includes indoor unit cleaning, blower and coil cleaning, drain tray cleaning, outdoor unit rinse, filter wash, and a basic cooling check.',
    },
    {
      question: 'Will this improve cooling?',
      answer: 'It usually improves airflow and cooling when dust or blocked drainage is the issue. Gas leakage, compressor faults, or PCB problems need separate diagnosis.',
    },
    {
      question: 'Do I need to provide water or tools?',
      answer: 'The technician carries service tools. Please keep a water source and power point accessible near the AC area.',
    },
  ],
  'AC Installation': [
    {
      question: 'What is included in AC installation?',
      answer: 'The service includes indoor and outdoor unit mounting, standard copper pipe connection, drain pipe setup, electrical connection, vacuuming where required, and a trial run.',
    },
    {
      question: 'Are copper pipe and bracket charges included?',
      answer: 'Standard installation covers basic fitting. Extra copper pipe, outdoor stand, drain pipe extension, and special drilling are charged separately if needed.',
    },
    {
      question: 'How long does installation take?',
      answer: 'Most split AC installations take around 2 hours. Complex wall drilling, longer pipe routing, or high-rise outdoor placement may take longer.',
    },
  ],
  'AC Gas Refill': [
    {
      question: 'How do I know my AC needs gas refill?',
      answer: 'Common signs are low cooling, ice formation on the coil, longer cooling time, or the outdoor unit running continuously without effective cooling.',
    },
    {
      question: 'Is leak checking included?',
      answer: 'Basic pressure and leak diagnosis is included. Repairing a major leak or replacing damaged coils, valves, or pipes is charged separately.',
    },
    {
      question: 'Which gas will be used?',
      answer: 'The technician uses the gas type compatible with your AC model, such as R32, R410A, or R22, based on the appliance label and condition.',
    },
  ],
  'AC Uninstallation': [
    {
      question: 'Will the gas be saved during uninstallation?',
      answer: 'The technician attempts standard gas recovery before removing the indoor and outdoor units, if the AC is in working condition.',
    },
    {
      question: 'Does this include wall repair after removal?',
      answer: 'No. Wall patching, plastering, painting, or closing large holes is not included in AC uninstallation.',
    },
    {
      question: 'Can the same technician reinstall it elsewhere?',
      answer: 'Reinstallation is a separate service. You can book AC Installation after the unit is moved to the new location.',
    },
  ],
  'Switch & Socket Repair': [
    {
      question: 'What problems can be fixed in this service?',
      answer: 'Loose switches, faulty sockets, burnt regulators, sparking points, plug point issues, and minor wiring faults around the switchboard can be handled.',
    },
    {
      question: 'Are parts included in the price?',
      answer: 'The service price covers labor. Switches, sockets, regulators, plates, or other replacement parts are charged separately if required.',
    },
    {
      question: 'Will the technician check for safety issues?',
      answer: 'Yes. The technician checks for loose wiring, overheating, and basic continuity before completing the repair.',
    },
  ],
  'Light & Fan Installation': [
    {
      question: 'What can be installed under this service?',
      answer: 'Ceiling fans, wall fans, tube lights, LED panels, bulb holders, chandeliers, and similar light fixtures can be installed.',
    },
    {
      question: 'Does it include drilling or hook fitting?',
      answer: 'Basic hook or bracket fitting is included. False ceiling work, heavy chandelier support, or concealed wiring changes may cost extra.',
    },
    {
      question: 'Will the fan or light be tested after installation?',
      answer: 'Yes. The technician checks wiring, mounting stability, and basic operation before closing the job.',
    },
  ],
  'MCB & Wiring Fix': [
    {
      question: 'What issues are covered?',
      answer: 'MCB tripping, loose wiring, short circuit diagnosis, fuse replacement, and basic load or continuity checks are covered.',
    },
    {
      question: 'Does this include full house rewiring?',
      answer: 'No. Full rewiring, concealed wire replacement, and major electrical renovation are quoted separately after inspection.',
    },
    {
      question: 'Can the technician replace an MCB?',
      answer: 'Yes, if replacement is needed. The MCB cost is charged separately based on rating and brand.',
    },
  ],
  'Inverter / UPS Installation': [
    {
      question: 'What is included in inverter or UPS installation?',
      answer: 'The service includes inverter placement, battery connection, mains changeover wiring, basic load connection, and a working test.',
    },
    {
      question: 'Do I need to buy cables or battery separately?',
      answer: 'Battery, trolley, extra cables, lugs, and additional wiring material are charged separately if not already available.',
    },
    {
      question: 'Will the technician connect the full house load?',
      answer: 'The technician connects supported backup points as per inverter capacity. Heavy appliances may be excluded for safety.',
    },
  ],
  'RO Installation': [
    {
      question: 'What is included in RO installation?',
      answer: 'It includes wall mounting, inlet tap connection, drain pipe setup, filter flushing, leak check, and a trial run.',
    },
    {
      question: 'Are plumbing parts included?',
      answer: 'Basic installation labor is included. Extra tap, pipe extension, connectors, or special fittings are charged separately.',
    },
    {
      question: 'Can RO be installed in a rented house?',
      answer: 'Yes, if wall mounting and water connection are allowed. Please confirm drilling permission before the technician arrives.',
    },
  ],
  'RO Filter Replacement': [
    {
      question: 'Which filters can be replaced?',
      answer: 'Sediment filter, carbon filter, pre-filter, RO membrane, UV lamp, and other compatible filters can be replaced depending on your purifier model.',
    },
    {
      question: 'Are filter parts included in the price?',
      answer: 'The listed price covers labor. Filter or membrane cost is charged separately based on the brand and model.',
    },
    {
      question: 'Will TDS be checked after replacement?',
      answer: 'Yes. The technician performs a basic TDS and leakage check after replacing the filter.',
    },
  ],
  'RO Service & Cleaning': [
    {
      question: 'What does RO service include?',
      answer: 'It includes external cleaning, leak inspection, pressure check, pipe inspection, tank cleaning where accessible, and basic performance checks.',
    },
    {
      question: 'Does this include filter replacement?',
      answer: 'No. Filter or membrane replacement is charged separately if required after inspection.',
    },
    {
      question: 'How often should RO be serviced?',
      answer: 'Most homes should service the RO every 3 to 6 months, depending on water quality and usage.',
    },
  ],
  'Tap & Faucet Fitting': [
    {
      question: 'What fittings are covered?',
      answer: 'Kitchen taps, basin taps, bathroom faucets, health faucets, angle valves, and similar fittings can be installed or replaced.',
    },
    {
      question: 'Is the tap included in the price?',
      answer: 'No. The service price covers labor. Tap, faucet, washers, connectors, or other parts are charged separately if needed.',
    },
    {
      question: 'Will leakage be checked after fitting?',
      answer: 'Yes. The technician runs a basic leak test after installation or replacement.',
    },
  ],
  'Leak Repair': [
    {
      question: 'What types of leaks can be fixed?',
      answer: 'Visible pipe leaks, tap leaks, joint leaks, flush leaks, under-sink leakage, and minor bathroom or kitchen plumbing leaks are covered.',
    },
    {
      question: 'Does it include concealed pipe leakage?',
      answer: 'Basic diagnosis is included. Breaking tiles, replacing concealed pipes, or civil repair is quoted separately.',
    },
    {
      question: 'Are spare parts included?',
      answer: 'No. Washers, sealant, valves, connectors, pipes, and other materials are charged separately if required.',
    },
  ],
  'Geyser Installation': [
    {
      question: 'What is included in geyser installation?',
      answer: 'It includes wall mounting, inlet and outlet pipe connection, safety valve fitting, leakage check, and a basic heating test.',
    },
    {
      question: 'Is electrical wiring included?',
      answer: 'Connection to an existing power point is included. New wiring, plug point installation, or MCB work is charged separately.',
    },
    {
      question: 'Do I need to provide pipes and accessories?',
      answer: 'If pipes, nipples, valves, or fasteners are not available with the geyser, the technician can arrange them at extra cost.',
    },
  ],
  'Bathroom Plumbing': [
    {
      question: 'What bathroom plumbing work is covered?',
      answer: 'Shower issues, jet spray fitting, flush leakage, basin drainage, minor pipe repair, and visible bathroom fitting repairs are covered.',
    },
    {
      question: 'Does this include tile breaking?',
      answer: 'No. Tile breaking, concealed pipe replacement, waterproofing, and civil work are quoted separately after inspection.',
    },
    {
      question: 'Can multiple small issues be handled in one visit?',
      answer: 'Yes. The technician can inspect and fix multiple minor issues in the same visit, with extra labor or parts charged if needed.',
    },
  ],
  'Furniture Assembly': [
    {
      question: 'What furniture can be assembled?',
      answer: 'Beds, wardrobes, tables, chairs, racks, shelves, shoe cabinets, and most flat-pack furniture can be assembled.',
    },
    {
      question: 'Should I keep the manual and screws ready?',
      answer: 'Yes. Please keep the instruction manual, hardware pack, and all panels available before the technician arrives.',
    },
    {
      question: 'Does this include wall mounting?',
      answer: 'Basic assembly is included. Wall anchoring, extra drilling, or missing hardware may be charged separately.',
    },
  ],
  'Door Repair & Fitting': [
    {
      question: 'What door issues can be fixed?',
      answer: 'Sagging doors, hinge repair, latch alignment, handle replacement, lock fitting, and minor frame adjustment can be handled.',
    },
    {
      question: 'Are locks and hinges included?',
      answer: 'No. Labor is included in the service price. Locks, hinges, handles, screws, or other hardware are charged separately.',
    },
    {
      question: 'Can a new door be installed?',
      answer: 'Minor fitting can be handled. Full new door installation or frame modification may need inspection and a custom quote.',
    },
  ],
  'Wood Polishing': [
    {
      question: 'What does wood polishing include?',
      answer: 'It includes light sanding, surface cleaning, polish application, and buffing for a refreshed finish.',
    },
    {
      question: 'Can deep scratches or water damage be repaired?',
      answer: 'Minor marks may improve. Deep scratches, veneer damage, termite damage, or major restoration need separate assessment.',
    },
    {
      question: 'How long does the polish take to dry?',
      answer: 'Drying time depends on polish type and ventilation, but most surfaces need a few hours before regular use.',
    },
  ],
  'Custom Shelves & Brackets': [
    {
      question: 'What is included in shelf and bracket fitting?',
      answer: 'The technician measures, drills, fixes brackets, mounts shelves, checks leveling, and cleans the work area.',
    },
    {
      question: 'Are shelves or brackets included?',
      answer: 'No. Shelf boards, brackets, screws for special walls, and anchors are charged separately if not provided.',
    },
    {
      question: 'Can shelves be installed on any wall?',
      answer: 'Most brick or concrete walls are suitable. Tile, gypsum, or weak walls may need special anchors or may not support heavy loads.',
    },
  ],
  'TV Wall Mount': [
    {
      question: 'What is included in TV wall mounting?',
      answer: 'It includes bracket fitting, TV mounting, leveling, basic cable arrangement, and a stability check.',
    },
    {
      question: 'Is the wall mount bracket included?',
      answer: 'No. The bracket cost is separate unless you already have one. The technician can advise on compatible bracket types.',
    },
    {
      question: 'Can a TV be mounted on tile or gypsum wall?',
      answer: 'It depends on wall strength and TV size. The technician will inspect before drilling and may recommend a safer location.',
    },
  ],
  'Smart TV Setup': [
    {
      question: 'What does Smart TV setup include?',
      answer: 'It includes WiFi connection, basic account setup, app installation, OTT login assistance, channel setup, and picture or sound calibration.',
    },
    {
      question: 'Do you provide OTT subscriptions?',
      answer: 'No. Subscription charges are not included. The technician can help sign in using your existing accounts.',
    },
    {
      question: 'Can the technician connect soundbar or home theatre?',
      answer: 'Basic HDMI or Bluetooth connection can be done. Complex home theatre wiring may need a separate visit or quote.',
    },
  ],
  'Cable & Antenna Setup': [
    {
      question: 'What is covered in cable and antenna setup?',
      answer: 'It covers cable connection, DTH or antenna wiring, channel scan, signal check, and basic set-top box setup.',
    },
    {
      question: 'Are cable, dish, or antenna parts included?',
      answer: 'No. Cable wire, connectors, antenna, dish, LNB, and set-top box parts are charged separately if required.',
    },
    {
      question: 'Can signal issues always be fixed?',
      answer: 'Most wiring and alignment issues can be fixed. Provider outages, blocked line of sight, or damaged hardware may need replacement or provider support.',
    },
  ],
};

module.exports = { SERVICE_FAQS_BY_NAME };
