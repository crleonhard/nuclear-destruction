// Play styles for AI players. Each is a handful of numbers that the decision code in decide.js reads;
// nothing here knows the rules. To add a style, add an entry (and its name to the CHECK in migration 008).

export const AI_PERSONAS = ['HAWK', 'DIPLOMAT', 'OPPORTUNIST'];

export const PERSONAS = {
  HAWK: {
    label: 'Hawk',
    blurb: 'Builds missiles, declares war early and fires everything it has.',
    warTurn: 3,            // earliest turn it will declare war
    minMissiles: 35,       // and only with at least this many missiles in hand
    needsEdge: false,      // declares even if a spied rival looks stronger
    edgeFallback: 0,
    investTurns: 2,        // turns at the start spent growing factories instead of missiles
    investShare: 0.2,      // share of factories used for growth in those turns
    abmShare: 0.15,        // share of factories on ABMs in peacetime...
    abmPeaceStock: 15,     // ...until it holds this many
    abmWarStock: 30,       // during war it fills the ABM cap until it holds this many
    cores: 3,              // minors it tries to control at the start
    coresGrowEvery: 8,     // one more minor every this many turns
    margin: 0.1,           // how far ahead of a known rival it tries to stay in a minor (fraction of rival's index)
    fireShare: 1,          // share of its missiles it fires when it cannot eliminate anyone this turn
  },
  DIPLOMAT: {
    label: 'Diplomat',
    blurb: 'Grows first, courts many minors, defends heavily and strikes late.',
    warTurn: 10, minMissiles: 60, needsEdge: true, edgeFallback: 18,
    investTurns: 6, investShare: 0.33, abmShare: 0.35, abmPeaceStock: 30, abmWarStock: 45,
    cores: 5, coresGrowEvery: 5, margin: 0.2, fireShare: 0.6,
  },
  OPPORTUNIST: {
    label: 'Opportunist',
    blurb: 'Balanced. Waits until it looks at least as strong as the rivals it has spied on.',
    warTurn: 6, minMissiles: 45, needsEdge: true, edgeFallback: 12,
    investTurns: 4, investShare: 0.25, abmShare: 0.25, abmPeaceStock: 22, abmWarStock: 38,
    cores: 4, coresGrowEvery: 6, margin: 0.15, fireShare: 0.8,
  },
};

export const isPersona = (x) => typeof x === 'string' && Object.hasOwn(PERSONAS, x);
