use std::collections::{HashMap, HashSet};

use crate::core::model::{DataModelEntryDto, TransitionDto, Workflow, WorkflowDto};

use super::{
    index::ExportIndex,
    slots::build_slot_declarations,
    states::build_states,
    transitions::{build_edge_target_routes, build_transitions},
    types::EditorExportRequestDto,
};

fn make_transition_ids_unique(mut transitions: Vec<TransitionDto>) -> Vec<TransitionDto> {
    let mut used = HashSet::new();
    let mut next_suffix = HashMap::<String, u32>::new();

    for transition in &mut transitions {
        let base = if transition.id.trim().is_empty() {
            "transition".to_string()
        } else {
            transition.id.clone()
        };

        if used.insert(base.clone()) {
            transition.id = base.clone();
            next_suffix.entry(base).or_insert(2);
            continue;
        }

        let counter = next_suffix.entry(base.clone()).or_insert(2);
        loop {
            let candidate = format!("{base}__{}", *counter);
            *counter += 1;
            if used.insert(candidate.clone()) {
                transition.id = candidate;
                break;
            }
        }
    }

    transitions
}

pub(crate) fn build_workflow_from_editor(
    request: &EditorExportRequestDto,
) -> Result<Workflow, String> {
    let index = ExportIndex::new(request);
    let edge_routes = build_edge_target_routes(request, &index);
    let states = build_states(request, &index, &edge_routes);

    let root_nodes = states
        .iter()
        .filter(|state| state.parent_id.is_none())
        .collect::<Vec<_>>();
    let root_initial = root_nodes
        .iter()
        .copied()
        .find(|state| state.is_initial)
        .or_else(|| root_nodes.first().copied());

    Workflow::from_dto(WorkflowDto {
        name: None,
        initial_state_id: root_initial.map(|state| state.id.clone()),
        initial_scxml_state_id: root_initial.map(|state| state.scxml_id.clone()),
        states,
        // Editor edge ids are normally unique, but malformed/legacy graphs and
        // nested boundary projections must never make Code View fail.  The
        // semantic transition list is canonicalized here before model
        // validation so serialization always has unique internal ids.
        transitions: make_transition_ids_unique(build_transitions(request, &index)),
        data_model: request
            .data_model
            .iter()
            .map(|entry| DataModelEntryDto {
                id: entry.id.clone(),
                type_name: None,
                expression: entry.expression.clone(),
            })
            .collect(),
        slot_declarations: build_slot_declarations(request),
    })
}

#[cfg(test)]
mod tests {
    use super::build_workflow_from_editor;
    use crate::core::editor_export::types::{
        EditorBehaviorExitTransitionDto, EditorExportEdgeDto, EditorExportNodeDto,
        EditorExportRequestDto, EditorExportEventDto, EditorTransitionSourceDto,
    };
    use crate::core::scxml::{parse_scxml, serialize_scxml};

    fn node(id: &str, node_type: &str, parent: Option<&str>) -> EditorExportNodeDto {
        EditorExportNodeDto {
            id: id.into(),
            node_type: node_type.into(),
            parent_id: parent.map(str::to_string),
            label: id.into(),
            full_skill_name: id.into(),
            ..EditorExportNodeDto::default()
        }
    }

    #[test]
    fn flattens_atomic_parallel_lane() {
        let mut lane = node("Talk", "parallelLane", Some("parallel"));
        lane.full_skill_name = "Talk".into();
        let mut skill = node("talk-skill", "custom", Some("Talk"));
        skill.full_skill_name = "Talk".into();
        let request = EditorExportRequestDto {
            nodes: vec![node("parallel", "parallel", None), lane, skill],
            ..EditorExportRequestDto::default()
        };
        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.states.len(), 2);
        let talk = workflow
            .states
            .iter()
            .find(|state| state.id == "talk-skill")
            .unwrap();
        assert_eq!(talk.parent_id.as_deref(), Some("parallel"));
    }

    #[test]
    fn hoists_transition_leaving_compound() {
        let request = EditorExportRequestDto {
            nodes: vec![
                node("compound", "compound", None),
                node("Talk", "custom", Some("compound")),
                node("Outside", "custom", None),
            ],
            edges: vec![EditorExportEdgeDto {
                id: "edge-1".into(),
                source: "Talk".into(),
                target: "Outside".into(),
                source_handle: "error".into(),
                ..EditorExportEdgeDto::default()
            }],
            ..EditorExportRequestDto::default()
        };
        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.transitions.len(), 1);
        assert_eq!(workflow.transitions[0].source_state_id, "compound");
        assert_eq!(workflow.transitions[0].logical_sources.len(), 1);
        assert_eq!(workflow.transitions[0].logical_sources[0].state_id, "Talk");
        assert_eq!(workflow.transitions[0].logical_sources[0].handle, "error");
        assert_eq!(workflow.transitions[0].event, "Talk.error");
    }

    #[test]
    fn nested_container_exit_is_emitted_once_by_outermost_owner() {
        let request = EditorExportRequestDto {
            nodes: vec![
                node("outer", "compound", None),
                node("inner", "compound", Some("outer")),
                node("Talk", "custom", Some("inner")),
                node("Outside", "custom", None),
            ],
            edges: vec![EditorExportEdgeDto {
                id: "edge-1".into(),
                source: "Talk".into(),
                target: "Outside".into(),
                source_handle: "success".into(),
                ..EditorExportEdgeDto::default()
            }],
            ..EditorExportRequestDto::default()
        };

        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.transitions.len(), 1);
        assert_eq!(workflow.transitions[0].source_state_id, "outer");
        assert_eq!(workflow.transitions[0].id.as_str(), "edge-1");
    }


    // Regression: the Bonsai runtime does not reliably leave a Parallel when
    // the exiting event handler is declared directly on <parallel>. It must be
    // emitted on the lane's semantic Compound, not duplicated in every lane.
    #[test]
    fn parallel_exit_is_serialized_inside_its_source_lane_compound() {
        let mut talk_lane = node("talk-lane", "parallelLane", Some("parallel"));
        talk_lane.label = "TalkPart".into();
        talk_lane.full_skill_name = "TalkPart".into();
        let mut talk_wrapper = node("talk-wrap", "compound", Some("talk-lane"));
        talk_wrapper.label = "TalkPart".into();
        talk_wrapper.full_skill_name = "TalkPart".into();
        let mut wait_lane = node("wait-lane", "parallelLane", Some("parallel"));
        wait_lane.label = "Lane_2".into();
        wait_lane.full_skill_name = "Lane_2".into();
        let mut wait_wrapper = node("wait-wrap", "compound", Some("wait-lane"));
        wait_wrapper.label = "Lane_2".into();
        wait_wrapper.full_skill_name = "Lane_2".into();
        let mut wait1 = node("wait-1", "custom", Some("wait-wrap"));
        wait1.full_skill_name = "Wait#1".into();
        let mut wait2 = node("wait-2", "custom", Some("talk-wrap"));
        wait2.full_skill_name = "Wait#2".into();
        let mut end = node("end", "custom", None);
        end.full_skill_name = "End".into();
        end.is_final = true;
        let mut fatal = node("fatal", "custom", None);
        fatal.full_skill_name = "Fatal".into();
        fatal.is_final = true;
        let request = EditorExportRequestDto {
            nodes: vec![node("parallel", "parallel", None), talk_lane, talk_wrapper,
                wait2, wait_lane, wait_wrapper, wait1, end, fatal],
            edges: vec![
                EditorExportEdgeDto { id: "exit-success".into(), source: "wait-1".into(),
                    source_handle: "success".into(), target: "end".into(),
                    logical_sources: vec![EditorTransitionSourceDto {
                        state_id: "wait-1".into(), handle: "success".into(),
                    }], ..Default::default() },
                EditorExportEdgeDto { id: "exit-fatal".into(), source: "wait-1".into(),
                    source_handle: "fatal".into(), target: "fatal".into(),
                    ..Default::default() },
            ],
            ..Default::default()
        };
        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.transitions.len(), 2);
        assert!(workflow.transitions.iter().all(|tr| tr.source_state_id == "wait-wrap"));
        assert_eq!(workflow.transitions[0].event, "Wait.success");
        assert_eq!(workflow.transitions[1].event, "Wait.fatal");
        let xml = serialize_scxml(&workflow).unwrap();
        let parallel_body = xml.split("<parallel id=\"parallel\"").nth(1).unwrap();
        let talk_body = parallel_body.split("<state id=\"TalkPart\"").nth(1).unwrap();
        let wait_body = talk_body.split("<state id=\"Lane_2\"").nth(1).unwrap();
        assert!(!parallel_body.split("<state id=").next().unwrap().contains("<transition"));
        assert!(!talk_body.split("<state id=").next().unwrap().contains("<transition"));
        assert!(wait_body.contains("<transition event=\"Wait.success\" target=\"End\""));
        assert!(wait_body.contains("<transition event=\"Wait.fatal\" target=\"Fatal\""));
        let reopened = parse_scxml(&xml).unwrap();
        let lane = reopened.states.iter().find(|s| s.scxml_id == "Lane_2").unwrap();
        assert!(reopened.transitions.iter().all(|tr| tr.source_state_id == lane.id));
    }

    #[test]
    fn parallel_lane_exit_without_editor_wrapper_is_kept_on_lane() {
        let request = EditorExportRequestDto {
            nodes: vec![node("p", "parallel", None),
                node("lane", "parallelLane", Some("p")),
                node("wait", "custom", Some("lane")),
                node("out", "custom", None)],
            edges: vec![EditorExportEdgeDto {
                id: "e".into(), source: "wait".into(), source_handle: "success".into(),
                target: "out".into(), ..Default::default()
            }],
            ..Default::default()
        };
        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.transitions.len(), 1);
        assert_eq!(workflow.transitions[0].source_state_id, "lane");
    }

    #[test]
    fn imported_parallel_event_is_not_duplicated_after_lane_ownership_repair() {
        let mut parallel = node("p", "parallel", None);
        parallel.events.push(EditorExportEventDto {
            id: "Wait.success".into(), raw_event: "Wait.success".into(),
            target: "out".into(), ..Default::default()
        });
        let request = EditorExportRequestDto {
            nodes: vec![parallel, node("lane", "parallelLane", Some("p")),
                node("wait", "custom", Some("lane")), node("out", "custom", None)],
            edges: vec![EditorExportEdgeDto {
                id: "original".into(), source: "wait".into(), source_handle: "success".into(),
                target: "out".into(), imported_raw_event: "Wait.success".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.transitions.len(), 1);
        assert_eq!(workflow.transitions[0].source_state_id, "lane");
    }

    #[test]
    fn ordinary_compound_exit_still_uses_outermost_compound() {
        let request = EditorExportRequestDto {
            nodes: vec![node("outer", "compound", None),
                node("inner", "compound", Some("outer")),
                node("wait", "custom", Some("inner")),
                node("out", "custom", None)],
            edges: vec![EditorExportEdgeDto {
                id: "e".into(), source: "wait".into(), source_handle: "success".into(),
                target: "out".into(), ..Default::default()
            }],
            ..Default::default()
        };
        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.transitions[0].source_state_id, "outer");
    }

    #[test]
    fn duplicate_editor_edge_ids_are_made_unique_for_serialization() {
        let request = EditorExportRequestDto {
            nodes: vec![
                node("A", "custom", None),
                node("B", "custom", None),
                node("C", "custom", None),
            ],
            edges: vec![
                EditorExportEdgeDto {
                    id: "edge-duplicate".into(),
                    source: "A".into(),
                    target: "B".into(),
                    source_handle: "success".into(),
                    ..EditorExportEdgeDto::default()
                },
                EditorExportEdgeDto {
                    id: "edge-duplicate".into(),
                    source: "A".into(),
                    target: "C".into(),
                    source_handle: "error".into(),
                    ..EditorExportEdgeDto::default()
                },
            ],
            ..EditorExportRequestDto::default()
        };

        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.transitions.len(), 2);
        assert_ne!(workflow.transitions[0].id, workflow.transitions[1].id);
    }

    #[test]
    fn preserves_multiple_logical_sources_for_one_boundary_transition() {
        let request = EditorExportRequestDto {
            nodes: vec![
                node("compound", "compound", None),
                node("talk-a", "custom", Some("compound")),
                node("talk-b", "custom", Some("compound")),
                node("outside", "custom", None),
            ],
            edges: vec![EditorExportEdgeDto {
                id: "edge-shared".into(),
                source: "talk-a".into(),
                target: "outside".into(),
                source_handle: "success".into(),
                logical_sources: vec![
                    EditorTransitionSourceDto {
                        state_id: "talk-a".into(),
                        handle: "success".into(),
                    },
                    EditorTransitionSourceDto {
                        state_id: "talk-b".into(),
                        handle: "success".into(),
                    },
                ],
                ..EditorExportEdgeDto::default()
            }],
            ..EditorExportRequestDto::default()
        };

        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.transitions.len(), 1);
        assert_eq!(workflow.transitions[0].source_state_id, "compound");
        assert_eq!(workflow.transitions[0].logical_sources.len(), 2);
        assert_eq!(workflow.transitions[0].logical_sources[0].state_id, "talk-a");
        assert_eq!(workflow.transitions[0].logical_sources[1].state_id, "talk-b");
    }

    #[test]
    fn merges_logical_sources_when_equivalent_boundary_edges_collapse() {
        let mut talk_a = node("talk-a", "custom", Some("compound"));
        talk_a.full_skill_name = "Talk".into();
        let mut talk_b = node("talk-b", "custom", Some("compound"));
        talk_b.full_skill_name = "Talk".into();
        let request = EditorExportRequestDto {
            nodes: vec![
                node("compound", "compound", None),
                talk_a,
                talk_b,
                node("outside", "custom", None),
            ],
            edges: vec![
                EditorExportEdgeDto {
                    id: "edge-a".into(),
                    source: "talk-a".into(),
                    target: "outside".into(),
                    source_handle: "success".into(),
                    ..EditorExportEdgeDto::default()
                },
                EditorExportEdgeDto {
                    id: "edge-b".into(),
                    source: "talk-b".into(),
                    target: "outside".into(),
                    source_handle: "success".into(),
                    ..EditorExportEdgeDto::default()
                },
            ],
            ..EditorExportRequestDto::default()
        };

        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.transitions.len(), 1);
        assert_eq!(workflow.transitions[0].event, "Talk.success");
        assert_eq!(workflow.transitions[0].logical_sources.len(), 2);
        assert!(workflow.transitions[0]
            .logical_sources
            .iter()
            .any(|source| source.state_id == "talk-a"));
        assert!(workflow.transitions[0]
            .logical_sources
            .iter()
            .any(|source| source.state_id == "talk-b"));
    }

    #[test]
    fn preserves_behavior_exit_send() {
        let mut exit = node("Nop", "custom", None);
        exit.is_behavior_exit = true;
        exit.behavior_exit_transitions = vec![EditorBehaviorExitTransitionDto {
            trigger_event: "Nop.fatal".into(),
            send_events: vec!["behavior.success".into()],
        }];
        let request = EditorExportRequestDto {
            nodes: vec![exit],
            ..EditorExportRequestDto::default()
        };
        let workflow = build_workflow_from_editor(&request).unwrap();
        assert_eq!(workflow.transitions[0].target_state_id, None);
        assert_eq!(workflow.transitions[0].sent_events, vec!["behavior.success"]);
    }
}
