;; Inferred from big-map.json, whose tile matrix is tiles[x][y].
;;
;; Sector layout:
;;   l1 l4 l7
;;   l2 l5 l8
;;   l3 l6 l9
;;
;; Each 5,5!,5 component is represented as one transfer POI. Parallel
;; bridges between the same sectors use an "a" or "b" suffix.
;;
;; Transfer interaction tiles (the 5! bridge centers):
;;   t12=(4,9)    t14=(11,3)   t23=(4,22)
;;   t25a=(11,13) t25b=(11,18) t36=(11,28)
;;   t39=(18,35)  t45=(18,9)   t47=(24,2)
;;   t56=(18,22)  t57=(25,9)   t69a=(25,26)
;;   t69b=(25,31) t78=(32,9)   t89=(32,22)

(define (problem big_map_problem)
(:domain big_map_domain)

(:objects
    l1 l2 l3 l4 l5 l6 l7 l8 l9 - location

    s1 s2 s3 s7
    d3 d4 d8 d9
    t12 t14 t23 t25a t25b t36 t39 t45
    t47 t56 t57 t69a t69b t78 t89 - point_of_interest

    a1 a2 a3 a4 a5 a6 a7 a8 a9 - agent
    source1 source2 source3 source7 - source_flow
)

(:init
    ;; POI kinds.
    (is_spawner s1)
    (is_spawner s2)
    (is_spawner s3)
    (is_spawner s7)

    (is_delivery d3)
    (is_delivery d4)
    (is_delivery d8)
    (is_delivery d9)

    (is_transfer t12)
    (is_transfer t14)
    (is_transfer t23)
    (is_transfer t25a)
    (is_transfer t25b)
    (is_transfer t36)
    (is_transfer t39)
    (is_transfer t45)
    (is_transfer t47)
    (is_transfer t56)
    (is_transfer t57)
    (is_transfer t69a)
    (is_transfer t69b)
    (is_transfer t78)
    (is_transfer t89)

    ;; Sector l1: spawner at x=10..11,y=8..9.
    (agent_at a1 l1)
    (poi_at s1 l1)
    (poi_at t12 l1)
    (poi_at t14 l1)
    (pickup_enabled s1 l1)
    (source_flow_on source1 s1)

    ;; Sector l2: spawner at x=0,y=15..16.
    (agent_at a2 l2)
    (poi_at s2 l2)
    (poi_at t12 l2)
    (poi_at t23 l2)
    (poi_at t25a l2)
    (poi_at t25b l2)
    (pickup_enabled s2 l2)
    (source_flow_on source2 s2)

    ;; Sector l3: spawner at x=3..4,y=33 and delivery at x=0,y=28..29.
    (agent_at a3 l3)
    (poi_at s3 l3)
    (poi_at d3 l3)
    (poi_at t23 l3)
    (poi_at t36 l3)
    (poi_at t39 l3)
    (pickup_enabled s3 l3)
    (dropoff_enabled d3 l3)
    (source_flow_on source3 s3)

    ;; Sector l4: delivery at x=17..18,y=0.
    (agent_at a4 l4)
    (poi_at d4 l4)
    (poi_at t14 l4)
    (poi_at t45 l4)
    (poi_at t47 l4)
    (dropoff_enabled d4 l4)

    ;; Sector l5.
    (agent_at a5 l5)
    (poi_at t25a l5)
    (poi_at t25b l5)
    (poi_at t45 l5)
    (poi_at t56 l5)
    (poi_at t57 l5)

    ;; Sector l6.
    (agent_at a6 l6)
    (poi_at t36 l6)
    (poi_at t56 l6)
    (poi_at t69a l6)
    (poi_at t69b l6)

    ;; Sector l7: spawner at x=31..33,y=0.
    (agent_at a7 l7)
    (poi_at s7 l7)
    (poi_at t47 l7)
    (poi_at t57 l7)
    (poi_at t78 l7)
    (pickup_enabled s7 l7)
    (source_flow_on source7 s7)

    ;; Sector l8: delivery at x=36,y=15..16.
    (agent_at a8 l8)
    (poi_at d8 l8)
    (poi_at t78 l8)
    (poi_at t89 l8)
    (dropoff_enabled d8 l8)

    ;; Sector l9: delivery POI with tiles at x=33,y=33 and x=36,y=29.
    (agent_at a9 l9)
    (poi_at d9 l9)
    (poi_at t39 l9)
    (poi_at t69a l9)
    (poi_at t69b l9)
    (poi_at t89 l9)
    (dropoff_enabled d9 l9)
)

(:goal (and
    (delivered source1)
    (delivered source2)
    (delivered source3)
    (delivered source7)
    ; BEGIN GENERATED HAS_VISITED GOALS
    ; END GENERATED HAS_VISITED GOALS
))

)
