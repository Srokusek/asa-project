import "dotenv/config"
import { DjsConnect } from "@unitn-asa/deliveroo-js-sdk"

/**
 *the goal for now is to create a forward-compatible skeleton of an agent
 *main feature is that the agent should be able to be fully independent in simple scenarios (for now)
 */


//Type defs for beliefs
/**
 * @typedef {{
 * x: number, 
 * y: number
 * }} Position
 */

/**
 * @typedef {{ 
 * id: string, 
 * name: string, 
 * position: Position, 
 * score: number
 * }} SelfBelief
 */

/**
 * @typedef { Map< string, {
 * id: string, 
 * carriedBy?: string, 
 * position: Position, 
 * reward: number
 * } > } ParcelBelief
 */

/**
 * @typedef {{
 * id: string, 
 * carriedBy?: string, 
 * position: Position, 
 * reward: number
 * }} ParcelSnapshot
 */

/**
 * @typedef {{ 
 * me: SelfBelief, 
 * parcels: ParcelSnapshot[], 
 * version: number, 
 * updatedAt: number
 * }} BeliefSnapshot
 */

function createBeliefStore () {
    /**
     * @type {SelfBelief}
     */
    let me  = {id: "", name: "", position: {x: -1, y: -1}, score: 0};

    /**
     * @type {ParcelBelief}
     */
    let parcelsMap = new Map();

    let version = 0;
    let updatedAt = Date.now()

    return {
        /**
         * @param {{id: string, name: string, x: number, y: number, score: number}} payload 
         */
        updateSelf: function(payload) {
            me.id = payload.id;
            me.name = payload.name;
            me.position.x = payload.x ?? -1;
            me.position.y = payload.y ?? -1;
            me.score = payload.score;
            version++; //keep track of internal version
            updatedAt = Date.now() //keep track of update time
        },

        updateParcels: function(sensing) {
            for ( const p of sensing.parcels ) {
                parcelsMap.set(p.id, { id: p.id, position: {x: p.x, y: p.y}, carriedBy: p.carriedBy, reward: p.reward});
            }
            for ( const p of parcelsMap.values() ) {
                // TODO make the sensing cleanup use faster code
                if ( sensing.parcels.map( p => p.id ).find( id=> id == p.id ) == undefined ) {
                    parcelsMap.delete( p.id ); //delete key-value pairs for parcels which are no longer sensed
                }
            }
            version++;
            updatedAt = Date.now();
        },

        getSnapshot: function() {
            return {
                // TODO: might want to fix exposed position object to prevent any future issues
                me: {...me},
                parcels: Array.from(parcelsMap.values(), (p) => ({ ...p })),
                version,
                updatedAt
            };
        }
    }
}

//create connection
const socket = DjsConnect()

const beliefs = createBeliefStore()

//update self belief at each change
socket.onYou( ( {id, name, x, y, score} ) => beliefs.updateSelf( {id, name, x, y, score} ))

//update beliefs about parcels at each sensing event
socket.onSensing ( async ( sensing ) => {
    beliefs.updateParcels( sensing )
})

/**
 * desire generation section
 */

//define a type for each of the different desires, since each will likely require different values

/**
 * @typedef { {
 * kind: "pick_up", 
 * createdAt: number, 
 * sourceId: string, 
 * target: Position,
 * metadata?: {reward?: number}
 * }} PickUpCandidate
 */

/**
 * @typedef { {
 * kind: "idle", 
 * createdAt: number, 
 * sourceId: null, 
 * target: null,
 * metadata?: {reason: "no_visible_parcels"}
 * }} IdleCandidate
 */

/**
 * @typedef {PickUpCandidate | IdleCandidate} DesireCandidate
 */

/**
 * @param { BeliefSnapshot } snapshot contains a snapshot of the beliefs
 */
function generateDesires ( snapshot ) {
    /**
     * @type { DesireCandidate[] }
     */
    const candidates = [];

    //simple behavior for now, 
    //blindly pick a parcel that is sensed and go pick it up
    //if no parcels sensed, just idle

    for ( const p of snapshot.parcels ) { //create a pick up desire for each sensed parcel
        if ( ! p.carriedBy ) {
            candidates.push( { 
                kind: "pick_up", 
                createdAt: Date.now(), 
                sourceId: p.id, 
                target: p.position, 
                metadata: {reward: p.reward}} )
        }
    }
    if ( candidates.length == 0) { //if no other candidates were generated
        candidates.push( {
            kind: "idle",
            createdAt: Date.now(),
            sourceId: null,
            target: null,
            metadata: {reason: "no_visible_parcels"}
        })
    }

    return candidates
}

/**
 * @typedef { {candidate: DesireCandidate, utility: number} } ScoredCandidate
 * @typedef { function(DesireCandidate, BeliefSnapshot): number} UtilityFunction
 */

/**
 * @param {Position} a
 * @param {Position} b 
 * @type { function(a, b): number }
 */
function manhattan (a, b) {
    const dx = Math.abs( Math.round(a.x) - Math.round(b.x));
    const dy = Math.abs( Math.round(a.y) - Math.round(b.y));
    return dx+dy;
}

/**
 * @type {UtilityFunction}
 */
function blindUtility (candidate, belief_snapshot) {
    let utility = 0

    if ( candidate.kind == "pick_up") {
        let a = belief_snapshot.me.position;
        let b = candidate.target;
        utility = -manhattan(a, b);
    }
    if ( candidate.kind == "idle") { //set low utility -> prefer to do pick up
        utility = -999;
    }
    
    return utility
}

/**
 * @type { function(DesireCandidate[], BeliefSnapshot, UtilityFunction): ScoredCandidate[] }
 */
function scoreCandidates ( candidate_list, belief_snapshot, utility_f) { //scored each of the candidate desires
    /**
     * @type {ScoredCandidate[]}
     */
    let scored_candidate_list = [];
    for ( const c of candidate_list ) {
        let u = utility_f(c, belief_snapshot); //can change the utility function
        scored_candidate_list.push({candidate: c, utility: u}); //return ScoredCandidate
    }
    return scored_candidate_list;
}

/**
 * @type { function(ScoredCandidate[]): ScoredCandidate }
 */
function selectCandidate (scoredCandidateList) { //select the candidate with the highest utility
    return scoredCandidateList.reduce((best, current) => {
        return current.utility > best.utility ? current : best;
    });
}

//Types for planner/revision/plans

/** 
 * @typedef {{ok: boolean, status: "success"|"failed"|"cancelled", reason: string, details?: any}} PlanResult
 */

/**
 * @typedef {{
 * id: string,
 * kind: "idle"|"pick_up",
 * candidate: DesireCandidate,
 * createdAt: number,
 * stop: () => void,
 * execute: () => Promise<PlanResult>
 * }} Plan
 */

/**
 * @typedef {{
 * getSnapshot: () => BeliefSnapshot,
 * move: (direction: "up"|"down"|"left"|"right") => Promise<any>,
 * pickup: () => Promise<any>,
 * sleep: (ms: number) => Promise<void>,
 * now: () => number,
 * log: (...args: any[]) => void
 * }} PlannerDeps
 */

//helper functions

function createId(prefix, nowFn) {
  return prefix + "-" + String(nowFn()) + "-" + Math.floor(Math.random() * 100000);
}

/**
 * @param {Position} a 
 * @param {Position} b 
 * @returns 
 */
function isSamePosition(a, b) {
    return a.x === b.x && a.y === b.y
}

/**
 * @param {Position} from 
 * @param {Position} to 
 */
function nextDirection(from, to) {
    if (from.x < to.x) return "right";
    if (from.x > to.x) return "left";
    if (from.y < to.y) return "up";
    if (from.y > to.y) return "down";
    return null;
}

/**
 * @param {BeliefSnapshot} snapshot 
 * @param {string} parcelId 
 */
function parcelStillAvailable(snapshot, parcelId) {
    const p = snapshot.parcels.find((x) => x.id == parcelId);
    return !!p && !p.carriedBy; //check if parcel still seen and is still not carried
}

//Planner factory
// TODO: might want to change this into hierarchical classes later on

function createPlanner(deps) {
    function buildIdlePlan(candidate) {
        let stopped = false; //used to stop plan if necessary
        return {
            id: createId("plan-idle", deps.now),
            kind: "idle",
            candidate,
            createdAt:deps.now(),
            stop: () => { stopped = true; },
            execute: async () => {
                if (stopped) return { ok: false, status: "cancelled", reason: "stopped_before_start"};
                await deps.sleep(250); //TODO: change this latter to have a better sensing 
                if (stopped) return { ok: false, status: "cancelled", reason: "stopped_during_idle"};
                return { ok: true, status: "success", reason: "idle_wait_complete"};
            }
        };
    }

    function buildPickUpPlan(candidate) {
        let stopped = false;

        return {
            id: createId("plan-pickup", deps.now),
            kind: "pick_up",
            candidate, 
            createdAt: deps.now(),
            stop: () => { stopped = true; },
            execute: async () => {
                //check that the target is still available
                let snapshot = deps.getSnapshot();
                if (!parcelStillAvailable(snapshot, candidate.sourceId)) {
                    return { ok: false, status: "failed", reason: "target_invalid_before_move"};
                }

                //blindly move toward target
                while (!stopped) {
                    snapshot = deps.getSnapshot();
                    const mePos = snapshot.me.position;
                    const target = candidate.target;

                    if (isSamePosition(mePos, target)) break; //already at target location

                    if (!parcelStillAvailable(snapshot, candidate.sourceId)) {
                        return {ok: false, status: "failed", reason: "target_invalid_during_move"};
                    }

                    const direction = nextDirection(mePos, target);
                    if (!direction) break;

                    const moved = await deps.move(direction);
                    if (!moved) {
                        return {ok: false, status: "failed", reason: "move_blocked"};
                    }
                }

                if (stopped) {
                    return { ok: false, status: "cancelled", reason: "stopped_during_move" };
                }

                //check again before pickup
                snapshot = deps.getSnapshot();
                if (!parcelStillAvailable(snapshot, candidate.sourceId)) {
                    return { ok: false, status: "failed", reason: "target_invalid_before_pickup" };
                }

                //pick up parcel
                await deps.pickup();

                if (stopped) {
                return { ok: false, status: "cancelled", reason: "stopped_after_pickup" };
                }

                return { ok: true, status: "success", reason: "pickup_complete" };
            }
        };
    }

    function buildPlan(candidate) {
        if (candidate.kind === "idle") return buildIdlePlan(candidate);
        if (candidate.kind === "pick_up") return buildPickUpPlan(candidate);
        return null;
    }

    return {buildPlan};
}

//revision policy
function createRevisionPolicy(mode) {
    return {
        shouldReplace: function(activeScored, nextScored) {
            if (mode === "replace") return true;
            if (mode === "keep") return false;
            //TODO add something more robust, taking into account the different utility
            return false;
        }
    };
}

//plan runner
function createRunner(deps) {
  let activePlan = null;
  let activeScore = null;

  async function runPlan(plan, scoredCandidate) {
    if (activePlan) {
      return { ok: false, status: "failed", reason: "busy_active_plan" };
    }

    activePlan = plan;
    activeScore = scoredCandidate;
    deps.log("plan_start", plan.kind, plan.id);

    try {
      const res = await plan.execute();
      deps.log("plan_end", plan.kind, plan.id, res.status, res.reason);
      return res;
    } finally {
      activePlan = null;
      activeScore = null;
    }
  }

  function cancelActive() {
    if (activePlan) activePlan.stop();
  }

  function hasActive() {
    return !!activePlan;
  }

  function getActiveScore() {
    return activeScore;
  }

  return { runPlan, cancelActive, hasActive, getActiveScore };
}

//simple control loop
const plannerDeps = {
    getSnapshot: () => beliefs.getSnapshot(),
    move: (direction) => socket.emitMove(direction),
    pickup: () => socket.emitPickup(),
    sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    now: () => Date.now(),
    log: (...args) => console.log(...args)
};

const planner = createPlanner(plannerDeps);
const runner = createRunner(plannerDeps);
const revisionPolicy = createRevisionPolicy("keep");
const utilityFunction = blindUtility;

async function controlLoop() {
    while (true) {
        const snapshot = beliefs.getSnapshot();
        const candidates = generateDesires(snapshot);
        const scoredCandidates = scoreCandidates(candidates, snapshot, utilityFunction);
        const selected = selectCandidate(scoredCandidates);

        if (selected) {
            const plan = planner.buildPlan(selected.candidate);

            if (plan) {
                if (!runner.hasActive()) {
                    await runner.runPlan(plan, selected);
                } else {
                    const activeScore = runner.getActiveScore();
                    if (revisionPolicy.shouldReplace(activeScore, selected)) {
                        runner.cancelActive();
                    }
                }
            }
        }
    }
}

controlLoop();