(define (problem test_problem) (:domain test_domain)
(:objects 
    l1 l2 l3 - location
    s1 s2 t12 t23 t13 d3 - point_of_interest
    a1 a2 a3 - agent
    source1 source2 - source_flow
)

(:init
    ;general initialization
    (is_delivery d3)
    (is_spawner s1)
    (is_spawner s2)
    (is_transfer t12)
    (is_transfer t13)
    (is_transfer t23)

    ;location 1
    (poi_at s1 l1)
    (poi_at t12 l1)
    (poi_at t13 l1)
    (source_flow_on source1 s1)
    (agent_at a1 l1)
    (pickup_enabled s1 l1)

    ;location 2
    (poi_at s2 l2)
    (poi_at t12 l2)
    (poi_at t23 l2)
    (agent_at a2 l2)
    (source_flow_on source2 s2)
    (pickup_enabled s2 l2)

    ;location 3
    (poi_at d3 l3)
    (poi_at t13 l3)
    (poi_at t23 l3)
    (agent_at a3 l3)
    (dropoff_enabled d3 l3)
)

(:goal (and
    (delivered source1)
    (delivered source2)
    ; BEGIN GENERATED HAS_VISITED GOALS
    ; END GENERATED HAS_VISITED GOALS
))

;un-comment the following line if metric is needed
;(:metric minimize (???))
)
