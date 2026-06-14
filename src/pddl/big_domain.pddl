;; Generic sector-routing domain for big-map.json.
;; The inferred map topology is declared in big_problem.pddl.

(define (domain big_map_domain)

(:requirements :strips :typing :negative-preconditions :equality)

(:types
    location
    point_of_interest
    agent
    source_flow
)

(:predicates
    (has_visited ?s - source_flow ?l - location)
    (poi_at ?poi - point_of_interest ?l - location)
    (source_flow_on ?s - source_flow ?poi - point_of_interest)
    (has_pickup_rule ?a - agent ?poi - point_of_interest)
    (has_delivery_rule ?a - agent ?poi - point_of_interest)
    (agent_at ?a - agent ?l - location)
    (is_spawner ?poi - point_of_interest)
    (is_delivery ?poi - point_of_interest)
    (is_transfer ?poi - point_of_interest)
    (pickup_enabled ?poi - point_of_interest ?l - location)
    (dropoff_enabled ?poi - point_of_interest ?l - location)
    (rule ?pickup - point_of_interest ?dropoff - point_of_interest ?a - agent)
    (delivered ?s - source_flow)
    (is_directed ?poi - point_of_interest ?from - location ?to - location)
)

;; Set the package-flow direction across a transfer bridge.
(:action set_transfer_direction
    :parameters (
        ?poi - point_of_interest
        ?from - location
        ?to - location
    )
    :precondition (and
        (is_transfer ?poi)
        (poi_at ?poi ?from)
        (poi_at ?poi ?to)
        (not (= ?from ?to))
        (not (is_directed ?poi ?from ?to))
        (not (is_directed ?poi ?to ?from))
    )
    :effect (and
        (is_directed ?poi ?from ?to)
        (dropoff_enabled ?poi ?from)
        (pickup_enabled ?poi ?to)
    )
)

;; Assign an agent in a sector a persistent pickup-to-dropoff rule.
(:action set_rule
    :parameters (
        ?pickup - point_of_interest
        ?dropoff - point_of_interest
        ?a - agent
        ?l - location
    )
    :precondition (and
        (agent_at ?a ?l)
        (poi_at ?pickup ?l)
        (poi_at ?dropoff ?l)
        (pickup_enabled ?pickup ?l)
        (dropoff_enabled ?dropoff ?l)
        (not (= ?pickup ?dropoff))
        (not (has_pickup_rule ?a ?dropoff))
        (not (has_delivery_rule ?a ?pickup))
        (not (has_pickup_rule ?a ?pickup))
    )
    :effect (and
        (rule ?pickup ?dropoff ?a)
        (has_pickup_rule ?a ?pickup)
        (has_delivery_rule ?a ?dropoff)
    )
)

;; Simulate one source flow moving through an assigned sector rule.
(:action execute_rule
    :parameters (
        ?pickup - point_of_interest
        ?dropoff - point_of_interest
        ?a - agent
        ?l - location
        ?s - source_flow
    )
    :precondition (and
        (agent_at ?a ?l)
        (poi_at ?pickup ?l)
        (poi_at ?dropoff ?l)
        (source_flow_on ?s ?pickup)
        (rule ?pickup ?dropoff ?a)
    )
    :effect (and
        (not (source_flow_on ?s ?pickup))
        (source_flow_on ?s ?dropoff)
        (has_visited ?s ?l)
    )
)

(:action mark_delivered
    :parameters (
        ?s - source_flow
        ?poi - point_of_interest
    )
    :precondition (and
        (source_flow_on ?s ?poi)
        (is_delivery ?poi)
        (not (delivered ?s))
    )
    :effect (and
        (delivered ?s)
    )
)

)
