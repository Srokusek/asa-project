import { DjsClientSocket, DjsConnect } from "@unitn-asa/deliveroo-js-sdk/client";
import dotenv from 'dotenv';
dotenv.config();

//-----BELIEFS-----
function createBeliefs() {
    let me = {id: null, x: 0, y: 0, score: 0};
    const parcels = new Map(); //id->{id, x, y, reward, carriedBy}
    const tiles = new Map(); //"x_y" -> {x, y, type}
    const tileLastSeen = new Map();

    return {
        //beliefs regarding me
        getMe: () => me,
        setMe: (agent) => {me = {...agent};},
        getPosition: () => ({x: me.x, y: me.y}),
        setPosition: (x, y) => {me.x = x; me.y = y;},
        getScore: () => me.score,
        setScore: (score) => {me.score = s},

        //beliefs about parcels
        getAllParcels: () => Array.from(parcels.values()),
        getParcel: (id) => parcels.get(id),
        setParcel: (p) => {parcels.set(p.id, {...p});},
        removeParcel: (id) => {parcels.delete(id);},
        syncParcels: (senseIds) => {
            for (const id of Array.from(parcels.keys())) {
                if (!senseIds.includes(id)) parcels.delete(id); //remove no longer sense parcels
            }
        },

        //map beliefs
        getTile: (x, y) => tiles.get(`${x}_${y}`),
        setTile: (t) => {
            const key = `${t.x}_${t.y}`;
            tiles.set(key, {...t});
            tileLastSeen.set(key, Date.now()); //set list time it was seen
        },
        getTimeSinceSeen: (x, y) => {
            const key = `${x}_${y}`;
            const lastSeen = tileLastSeen.get(key);
            return lastSeen ? Date.now() - lastSeen : 1000; //1000 if never seen
        },
        recordSpawnerSeen: (x, y) => {
            const key = `${x}_${y}`;
            tileLastSeen.set(key, Date.now());
        },
        isWalkable: (x, y) => {
            const t = tiles.get(`${x}_${y}`);
            return t && t.type !== '0'; //TODO: improve this to include arrow tiles
        },
        getTilesByType: (type) => Array.from(tiles.values()).filter(t => t.type === type),
        getTileCount: () => tiles.size,
    };
}

//-----DESIRES-----
function createDesires(beliefs) {
    return {
        generateDesires: () => { //TODO: implement a better desire generation
            const parcels = beliefs.getAllParcels();
            const me = beliefs.getMe();
            const desires = [];

            //pick up a parcel
            for (const p of parcels) {
                if (!p.carriedBy) {
                    desires.push({
                        type: "pickup",
                        target: p,
                        priority: p.reward || 1,//TODO this should also consider distance to delivery
                        goalId: `pickup_${p.id}`,
                    });
                }
            }

            //deliver a parcel that is being carried
            const carrying = parcels.find(p => p.carriedBy === me.id); //check for parcels carried by me
            if (carrying) {
                const deliveries = beliefs.getTilesByType("2"); //number for delivery points
                for (const d of deliveries) {
                    desires.push({
                        type: "deliver",
                        target: d,
                        priority: 1000, //TODO: make this smarter
                        goalId: `deliver_to_${d.x}_${d.y}`,
                    });
                }
            }

            //no parcels visible -> explore
            if (parcels.length === 0) {
                const spawners = beliefs.getTilesByType("1");
                if (spawners.length > 0) {
                    for (const s of spawners) {
                        const timeSince = beliefs.getTimeSinceSeen(s.x, s.y);
                        const recencyBoost = Math.min(timeSince / 1000, 500); //cap at 500 bonus

                        desires.push({
                            type: "explore",
                            target: s,
                            priority: 10 + recencyBoost,
                            goalId: `explore_${s.x}_${s.y}`,
                        });
                    }
                }
            }

            return desires;
        },
    };
}

//-----PLANNING---- (how to achieve a given plan)
function createPlanning(beliefs) {
    const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

    const getNeighbors = (x,y) => {
        const steps = [{dx:1,dy:0}, {dx:-1,dy:0}, {dx:0,dy:1}, {dx:0,dy:-1}]; // possible moves
        return steps
            .map(s => ({x: x+s.dx, y: y+s.dy}))
            .filter(p => beliefs.isWalkable(p.x, p.y)); //filter out moves which are not walkable
    };

    function planPath(start, goal) { //A* pathfinding with manhattan heuristic
        if (manhattan(start, goal) === 0) return [];

        const open = new Map();
        const closed = new Set();
        const key = p => `${p.x},${p.y}`;

        open.set(key(start), {pos:start, g: 0, f: manhattan(start, goal), parent: null});

        while (open.size > 0) {
            let current = null, currentKey = null;
            for (const [k, v] of open) {
                if (!current || v.f < current.f) {current = v; currentKey = k;}
            }

            if (currentKey === key(goal)) {
                const path = [];
                let n = current;
                while (n.parent) {path.unshift(n.pos); n = n.parent;}
                return path;
            }

            open.delete(currentKey);
            closed.add(currentKey);

            for (const nb of getNeighbors(current.pos.x, current.pos.y)) {
                const nk = key(nb);
                if (closed.has(nk)) continue;
                const g = current.g + 1;
                const f = g + manhattan(nb, goal);
                if (!open.has(nk) || g < open.get(nk).g) {
                open.set(nk, {pos: nb, g, f, parent: current});
                }
            }
            }
            return null;
        }

        return {
            planForIntention: (intention) => {
                const start = beliefs.getPosition();
                const goal = {x: intention.target.x, y: intention.target.y};
                const path = planPath(start, goal);

                if (path) {
                    return {
                        ...intention,
                        plan: path,
                        status: "planned",
                    };
                }
                return null;
            },
        };
}

//-----DELIBERATION-----
function createDeliberation(beliefs, meansEnds) {
    return {
        deliberate: (desires) => {
            if (desires.length === 0) return null;

            //sort by priority
            const sorted = desires.sort((a, b) => b.priority - a.priority);

            //attempt to make a plan for all desires in priority order
            for (const desire of sorted) {
                const plannedIntention = meansEnds.planForIntention(desire);
                if (plannedIntention && plannedIntention.plan) { //successfully made an execution plan
                    console.log(`[Deliberation] Selected intention: ${desire.type} priority=${desire.priority}`);
                    return plannedIntention; //this is the intention we commit to
                }
            }

            console.log(`[Deliberation] No feasible intention from ${desires.length} desires`);
            return null; //no feasible intention
        },
    };
}

//-----EXECUTION-----
//TODO: need to add error handling/recovery strategies
function createExecution(beliefs) {
    const getDirection = (from, to) => {
        if (to.x > from.x) return 'right';
        if (to.x < from.x) return 'left';
        if (to.y > from.y) return 'up';
        if (to.y < from.y) return 'down';
        return null;
    };

    return {
        async executePlan(socket, intention) { //async to wait for server responses
            if (!intention.plan || intention.plan.length === 0) { 
                console.log(`[Execution] Empty plan, attempting action at current location`);

                if (intention.type === "pickup") {
                    await socket.emitPickup();
                } else if (intention.type === "deliver") {
                    await socket.emitPutdown();
                }
                return true;
            }

            console.log(`[Execution] Following plan with ${intention.plan.length} steps`);

            for (let i=0; i < intention.plan.length; i++) {
                const step = intention.plan[i];
                const myPos = beliefs.getPosition();
                const dir = getDirection(myPos, step);

                if (!dir) {
                    console.log(`[Execution] Cannot determine direction from ${myPos.x},${myPos.y} to ${step.x},${step.y}`);
                    return false;
                }

                const moved = await socket.emitMove(dir);
                if (!moved) {
                    console.log(`[Execution] Move blocked at step ${i}, direction=${dir}`);
                    return false;
                }

                //wait for server position update
                await new Promise(res => setTimeout(res, 50));
            }

            //arrived at the destination, execute action
            console.log(`[Execution] Arrived, executing action: ${intention.type}`);
            if (intention.type === "pickup") {
                await socket.emitPickup();
            } else if (intention.type === "deliver") {
                await socket.emitPutdown();
            }

            return true;
        },
    };
}

//-----MAIN FUNCTION-----
export async function startAgent(options = {}) {
    const socket = DjsConnect(options.serverUrl, options.token);

    const beliefs = createBeliefs();
    const desires = createDesires(beliefs);
    const meansEnds = createPlanning(beliefs);
    const deliberation = createDeliberation(beliefs, meansEnds);
    const execution = createExecution(beliefs);

    console.log("[BDI Agent] starting...");

    //1) update beliefs
    socket.onTile((t) => {
        beliefs.setTile(t);
    });

    socket.onYou(({id, x, y, score}) => {
        beliefs.setMe({id, x, y, score});
    });

    socket.onConfig((cfg) => {
        console.log(cfg);
        console.log(cfg.GAME.map.tiles)
    })

    socket.onSensing((sensing) => {
        if (sensing.parcels) {
            for (const p of sensing.parcels) {
                beliefs.setParcel(p);
            }
            beliefs.syncParcels(sensing.parcels.map(p => p.id));
        }

        //update last seen of spawners
        const spawners = beliefs.getTilesByType("1");
        for (const s of spawners) {
            const myPos = beliefs.getPosition();
            const dist = Math.abs(myPos.x - s.x) + Math.abs(myPos.y - s.y); //get coords of tile
            if (dist <= 5) { //TODO: include the actual vision based on map
                beliefs.recordSpawnerSeen(s.x, s.y);
            }
        }
    });

    socket.onConnect(() => console.log("[BDI Agent] connected"))
    socket.onDisconnect(() => console.log("[BDI Agent] disconnected"))

    const waitFor = (p, ms) => Promise.race([p, new Promise(res => setTimeout(res, ms, null))]);

    const you = await waitFor(socket.me, 3000);
    if (you) {
        beliefs.setMe(you);
        console.log(`[BDI Agent] Initialized with agent position: ${you.x},${you.y}`);
    }

    const mapInfo = await waitFor(socket.map, 3000);
    if (mapInfo?.tiles) {
        for (const t of mapInfo.tiles) beliefs.setTile(t);
        console.log(`[BDI Agent] Initialized with ${mapInfo.tiles.length} tiles`);
    }

    console.log("[BDI Agent] Beliefs initialized, starting BDI loop...");

    //-----BDI LOOP-----
    let loopCount = 0;
    while (true) {
        loopCount++;



        //beliefs
        const me = beliefs.getMe();
        const parcelsCount = beliefs.getAllParcels().length;
        const tilesCount = beliefs.getTileCount();

        console.log(`\n[BDI Loop #${loopCount}] pos=${me.x},${me.y} score=${me.score} parcels=${parcelsCount} tiles=${tilesCount}`);

        //desires
        const desireList = desires.generateDesires();
        console.log(`   Generated ${desireList.length} desires`);

        //deliberation
        const intention = deliberation.deliberate(desireList);

        if (intention && intention.plan) {
            console.log(`   executing intention ${intention.type} to (${intention.target.x},${intention.target.y}), path length=${intention.plan.length}`);

            //execution
            const ok = await execution.executePlan(socket, intention);
            if (!ok) {
                console.log("   execution failed, new deliberation next cycle");
            }
        } else {
            console.log("   no feasible intention, waiting...");
            await new Promise(res => setTimeout(res, 500));
        }
    }
}

try {
    await startAgent({
        serverUrl: process.env.HOST,
        token: process.env.TOKEN,
    });
} catch (err) {
    console.error("[Error]", err);
}