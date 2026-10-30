use std::collections::{HashMap, HashSet};

use crate::core::model::{StateKind, Workflow};

use super::helpers::normalize_slot_type;

use super::types::{
    ActiveValidationRequestDto, ValidationAssignmentDto, ValidationEdgeDto, ValidationEventDto,
    ValidationNodeDto, ValidationNodeOverlayDto, ValidationParameterDto, ValidationRequestDto,
    ValidationSlotDefinitionDto, ValidationSlotDto, ValidationVariableDto,
};

fn node_type(kind: StateKind) -> &'static str {
    match kind {
        StateKind::Skill => "custom",
        StateKind::Compound => "compound",
        StateKind::Parallel => "parallel",
        StateKind::ParallelLane => "parallelLane",
        StateKind::Submachine => "submachine",
        StateKind::Final => "final",
    }
}

fn assignment(location: &str, expression: &str) -> ValidationAssignmentDto {
    ValidationAssignmentDto {
        location: location.to_string(),
        expression: expression.to_string(),
    }
}

fn variable(id: &str, type_name: Option<&str>, expression: &str) -> ValidationVariableDto {
    ValidationVariableDto {
        id: id.to_string(),
        type_name: type_name.unwrap_or_default().to_string(),
        expression: expression.to_string(),
    }
}

fn index_slot_definitions(
    definitions: &[ValidationSlotDefinitionDto],
) -> HashMap<usize, Option<&ValidationSlotDefinitionDto>> {
    let mut indexed = HashMap::with_capacity(definitions.len());
    for definition in definitions {
        // Repeated indices are ambiguous even if their other fields agree.
        indexed
            .entry(definition.index)
            .and_modify(|candidate| *candidate = None)
            .or_insert(Some(definition));
    }
    indexed
}

fn definition_missing(
    definitions: &HashMap<usize, Option<&ValidationSlotDefinitionDto>>,
    index: usize,
    key: &str,
    type_name: &str,
) -> bool {
    let Some(Some(definition)) = definitions.get(&index) else {
        return false;
    };
    definition.definition_missing
        && definition.key == key
        && normalize_slot_type(&definition.type_name) == normalize_slot_type(type_name)
}

fn collect_inherited_slot_paths(workflow: &Workflow) -> Vec<String> {
    let mut paths = HashSet::new();
    let mut add = |raw: &str| {
        let path = raw.trim().trim_start_matches('/');
        if !path.is_empty() {
            paths.insert(path.to_string());
        }
    };

    for declaration in &workflow.slot_declarations {
        if declaration.inherited {
            add(&declaration.xpath);
        }
    }

    for state in &workflow.states {
        for slot in state.input_slots.iter().chain(state.output_slots.iter()) {
            if let Some(inherited) = slot.inherited.as_deref() {
                if inherited.trim().is_empty() {
                    add(&slot.path);
                } else {
                    add(inherited);
                }
            }
        }
    }

    let mut paths = paths.into_iter().collect::<Vec<_>>();
    paths.sort();
    paths
}

pub(crate) fn build_active_validation_request(
    workflow: &Workflow,
    context: &ActiveValidationRequestDto,
) -> ValidationRequestDto {
    let mut overlays: HashMap<&str, (&ValidationNodeOverlayDto, bool)> = HashMap::new();
    for overlay in &context.node_overlays {
        overlays
            .entry(overlay.id.as_str())
            .and_modify(|entry| *entry = (overlay, true))
            .or_insert((overlay, false));
    }

    let behavior_exit_ids = workflow
        .transitions
        .iter()
        .filter(|transition| {
            transition.target_state_id.is_none() && !transition.sent_events.is_empty()
        })
        .map(|transition| transition.source_state_id.as_str())
        .collect::<HashSet<_>>();

    let mut nodes = workflow
        .states
        .iter()
        .map(|state| {
            let overlay_entry = overlays.get(state.id.as_str());
            let overlay = overlay_entry.map(|(overlay, _)| *overlay);
            let definition_overlay = overlay_entry
                .filter(|(_, ambiguous)| !ambiguous)
                .map(|(overlay, _)| *overlay);
            let input_definitions = index_slot_definitions(
                definition_overlay
                    .map(|overlay| overlay.input_slot_definitions.as_slice())
                    .unwrap_or_default(),
            );
            let output_definitions = index_slot_definitions(
                definition_overlay
                    .map(|overlay| overlay.output_slot_definitions.as_slice())
                    .unwrap_or_default(),
            );
            ValidationNodeDto {
                id: state.id.as_str().to_string(),
                node_type: node_type(state.kind).to_string(),
                parent_id: state
                    .parent_id
                    .as_ref()
                    .map(|parent| parent.as_str().to_string()),
                label: state.label.clone(),
                full_skill_name: state.full_skill_name.clone().unwrap_or_default(),
                source: state.source.clone().unwrap_or_default(),
                is_initial: state.is_initial,
                is_final: state.is_final || matches!(state.kind, StateKind::Final),
                is_behavior_exit: overlay.map(|value| value.is_behavior_exit).unwrap_or(false)
                    || behavior_exit_ids.contains(state.id.as_str()),
                is_collapsed: overlay
                    .map(|value| value.is_collapsed)
                    .unwrap_or(state.editor.collapsed),
                is_reference: state.editor.reference_of.is_some(),
                events: overlay
                    .map(|value| value.events.clone())
                    .unwrap_or_else(|| {
                        state
                            .events
                            .iter()
                            .map(|event| ValidationEventDto {
                                id: event.id.clone(),
                                synthetic: false,
                            })
                            .collect()
                    }),
                parameters: overlay
                    .map(|value| value.parameters.clone())
                    .unwrap_or_else(|| {
                        state
                            .parameters
                            .iter()
                            .map(|parameter| ValidationParameterDto {
                                key: parameter.key.clone(),
                                type_name: parameter.type_name.clone(),
                                required: parameter.required,
                                default_value: parameter.default_value.clone().unwrap_or_default(),
                                expression: parameter.expression.clone(),
                            })
                            .collect()
                    }),
                on_entry: overlay
                    .map(|value| value.on_entry.clone())
                    .unwrap_or_else(|| {
                        state
                            .on_entry
                            .iter()
                            .map(|value| assignment(&value.location, &value.expression))
                            .collect()
                    }),
                on_exit: overlay
                    .map(|value| value.on_exit.clone())
                    .unwrap_or_else(|| {
                        state
                            .on_exit
                            .iter()
                            .map(|value| assignment(&value.location, &value.expression))
                            .collect()
                    }),
                input_slots: state
                    .input_slots
                    .iter()
                    .enumerate()
                    .map(|(index, slot)| ValidationSlotDto {
                        key: slot.key.clone(),
                        type_name: slot.type_name.clone(),
                        path: slot.path.clone(),
                        definition_missing: definition_missing(
                            &input_definitions,
                            index,
                            &slot.key,
                            &slot.type_name,
                        ),
                    })
                    .collect(),
                output_slots: state
                    .output_slots
                    .iter()
                    .enumerate()
                    .map(|(index, slot)| ValidationSlotDto {
                        key: slot.key.clone(),
                        type_name: slot.type_name.clone(),
                        path: slot.path.clone(),
                        definition_missing: definition_missing(
                            &output_definitions,
                            index,
                            &slot.key,
                            &slot.type_name,
                        ),
                    })
                    .collect(),
                has_local_data_model: overlay
                    .map(|value| value.has_local_data_model)
                    .unwrap_or(false),
                local_data_model: overlay
                    .map(|value| value.local_data_model.clone())
                    .unwrap_or_default(),
            }
        })
        .collect::<Vec<_>>();

    // Include overlay nodes that are not yet in the stored workflow (e.g.
    // newly added nodes that haven't been committed). Without this, parameter
    // validation misses required-but-unset parameters on fresh nodes.
    let workflow_state_ids: HashSet<&str> = workflow
        .states
        .iter()
        .map(|state| state.id.as_str())
        .collect();
    for overlay in &context.node_overlays {
        if workflow_state_ids.contains(overlay.id.as_str()) {
            continue;
        }
        nodes.push(ValidationNodeDto {
            id: overlay.id.clone(),
            node_type: "custom".to_string(),
            parent_id: None,
            label: overlay.id.clone(),
            full_skill_name: String::new(),
            source: String::new(),
            is_initial: false,
            is_final: false,
            is_behavior_exit: overlay.is_behavior_exit,
            is_collapsed: overlay.is_collapsed,
            is_reference: false,
            events: overlay.events.clone(),
            parameters: overlay.parameters.clone(),
            on_entry: overlay.on_entry.clone(),
            on_exit: overlay.on_exit.clone(),
            input_slots: Vec::new(),
            output_slots: Vec::new(),
            has_local_data_model: overlay.has_local_data_model,
            local_data_model: overlay.local_data_model.clone(),
        });
    }

    let mut edges = Vec::new();
    for transition in &workflow.transitions {
        let target = if let Some(target_state_id) = transition.target_state_id.as_ref() {
            target_state_id.as_str().to_string()
        } else if !transition.target_scxml_id.trim().is_empty() {
            // Preserve unresolved editor targets so validation still reports a
            // missing-target problem instead of silently dropping the edge.
            transition.target_scxml_id.clone()
        } else {
            // Behavior forwarding exits are targetless semantic transitions
            // and are intentionally not visual editor edges.
            continue;
        };

        if transition.logical_sources.is_empty() {
            edges.push(ValidationEdgeDto {
                id: transition.id.as_str().to_string(),
                source: transition.source_state_id.as_str().to_string(),
                target: target.clone(),
                event: transition.event.clone(),
                source_handle: transition.event.clone(),
                semantic_source: transition.source_state_id.as_str().to_string(),
                assignments: transition
                    .assignments
                    .iter()
                    .map(|value| assignment(&value.location, &value.expression))
                    .collect(),
            });
            continue;
        }

        for source in &transition.logical_sources {
            edges.push(ValidationEdgeDto {
                id: transition.id.as_str().to_string(),
                source: source.state_id.as_str().to_string(),
                target: target.clone(),
                event: if source.handle.trim().is_empty() {
                    transition.event.clone()
                } else {
                    source.handle.clone()
                },
                source_handle: source.handle.clone(),
                semantic_source: source.state_id.as_str().to_string(),
                assignments: transition
                    .assignments
                    .iter()
                    .map(|value| assignment(&value.location, &value.expression))
                    .collect(),
            });
        }
    }

    let global_data_model = workflow
        .data_model
        .iter()
        .map(|entry| variable(&entry.id, entry.type_name.as_deref(), &entry.expression))
        .collect::<Vec<_>>();

    ValidationRequestDto {
        nodes,
        edges,
        global_data_model: global_data_model.clone(),
        available_data_model: if context.available_data_model.is_empty() {
            global_data_model
        } else {
            context.available_data_model.clone()
        },
        behavior_directory_keys: context.behavior_directory_keys.clone(),
        is_behavior_workflow: context.is_behavior_workflow,
        inherited_slot_paths: collect_inherited_slot_paths(workflow),
        ancestor_writer_slot_paths: context.ancestor_writer_slot_paths.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::model::Slot;
    use crate::core::scxml::{parse_scxml, serialize_scxml};
    use crate::core::validation::validate_editor_graph;

    fn workflow_with_duplicate_requests() -> Workflow {
        let mut workflow = parse_scxml(
            r#"<scxml initial="dialog.Talk#1"><state id="dialog.Talk#1"/><state id="dialog.Talk#2"/></scxml>"#,
        )
        .unwrap();
        for state in &mut workflow.states {
            state.input_slots = vec![
                Slot {
                    key: "text".into(),
                    type_name: "String".into(),
                    ..Default::default()
                },
                Slot {
                    key: "text".into(),
                    type_name: "Model".into(),
                    ..Default::default()
                },
                Slot {
                    key: "retained".into(),
                    type_name: "String".into(),
                    path: "/bound".into(),
                    inherited: Some("/outer".into()),
                    description: "Authored binding".into(),
                },
            ];
            state.output_slots = vec![state.input_slots[0].clone()];
        }
        workflow
    }

    fn descriptor(index: usize, type_name: &str) -> ValidationSlotDefinitionDto {
        ValidationSlotDefinitionDto {
            index,
            key: "text".into(),
            type_name: type_name.into(),
            definition_missing: true,
        }
    }

    fn has_empty(
        request: &ValidationRequestDto,
        node_id: &str,
        direction: &str,
        index: usize,
    ) -> bool {
        validate_editor_graph(request)
            .iter()
            .any(|problem| problem.id == format!("slot-{direction}-empty-{node_id}-{index}"))
    }

    #[test]
    fn activity_is_scoped_by_owned_node_direction_index_key_and_normalized_type() {
        let workflow = workflow_with_duplicate_requests();
        let first_id = workflow.states[0].id.as_str();
        let second_id = workflow.states[1].id.as_str();
        let context = ActiveValidationRequestDto {
            node_overlays: vec![ValidationNodeOverlayDto {
                id: second_id.into(),
                input_slot_definitions: vec![descriptor(0, " string ")],
                ..Default::default()
            }],
            ..Default::default()
        };
        let request = build_active_validation_request(&workflow, &context);
        assert!(has_empty(&request, first_id, "input", 0));
        assert!(!has_empty(&request, second_id, "input", 0));
        assert!(has_empty(&request, second_id, "input", 1));
        assert!(has_empty(&request, second_id, "output", 0));

        // Identical keys do not erase an adjacent binding with another type.
        let mut context = context;
        context.node_overlays[0].input_slot_definitions = vec![descriptor(1, "Model")];
        let request = build_active_validation_request(&workflow, &context);
        assert!(has_empty(&request, second_id, "input", 0));
        assert!(!has_empty(&request, second_id, "input", 1));

        // Even duplicate key/type pairs remain distinct by their owned index.
        let mut same_type_workflow = workflow.clone();
        same_type_workflow.states[1].input_slots[1].type_name = "String".into();
        context.node_overlays[0].input_slot_definitions = vec![descriptor(1, "String")];
        let request = build_active_validation_request(&same_type_workflow, &context);
        assert!(has_empty(&request, second_id, "input", 0));
        assert!(!has_empty(&request, second_id, "input", 1));
    }

    #[test]
    fn unmatched_or_ambiguous_activity_never_suppresses_an_owned_requirement() {
        let workflow = workflow_with_duplicate_requests();
        let node_id = workflow.states[1].id.as_str();
        let valid = descriptor(0, "String");
        let mut wrong_key = valid.clone();
        wrong_key.key = "other".into();
        let mut conflicting = valid.clone();
        conflicting.definition_missing = false;
        let mut duplicate_index_other_type = valid.clone();
        duplicate_index_other_type.type_name = "Model".into();
        let mut duplicate_index_other_key = valid.clone();
        duplicate_index_other_key.key = "other".into();
        for definitions in [
            vec![],
            vec![descriptor(9, "String")],
            vec![descriptor(0, "Model")],
            vec![wrong_key],
            vec![valid.clone(), valid.clone()],
            vec![valid.clone(), conflicting],
            vec![valid.clone(), duplicate_index_other_type],
            vec![valid.clone(), duplicate_index_other_key],
        ] {
            let context = ActiveValidationRequestDto {
                node_overlays: vec![ValidationNodeOverlayDto {
                    id: node_id.into(),
                    input_slot_definitions: definitions,
                    ..Default::default()
                }],
                ..Default::default()
            };
            let request = build_active_validation_request(&workflow, &context);
            assert!(has_empty(&request, node_id, "input", 0), "{context:?}");
        }

        for overlays in [
            vec![ValidationNodeOverlayDto {
                id: "same-class-visual-alias".into(),
                input_slot_definitions: vec![valid.clone()],
                ..Default::default()
            }],
            vec![ValidationNodeOverlayDto {
                id: node_id.into(),
                output_slot_definitions: vec![valid.clone()],
                ..Default::default()
            }],
            vec![
                ValidationNodeOverlayDto {
                    id: node_id.into(),
                    input_slot_definitions: vec![valid.clone()],
                    ..Default::default()
                },
                ValidationNodeOverlayDto {
                    id: node_id.into(),
                    ..Default::default()
                },
            ],
        ] {
            let request = build_active_validation_request(
                &workflow,
                &ActiveValidationRequestDto {
                    node_overlays: overlays,
                    ..Default::default()
                },
            );
            assert!(has_empty(&request, node_id, "input", 0));
        }
    }

    #[test]
    fn retirement_and_explicit_restoration_keep_owned_bindings_and_original_indices() {
        let workflow = workflow_with_duplicate_requests();
        let node_id = workflow.states[1].id.as_str();
        let saved_before = serialize_scxml(&workflow).unwrap();
        for retired in [false, true, false] {
            let mut definition = descriptor(0, "String");
            definition.definition_missing = retired;
            let context = ActiveValidationRequestDto {
                node_overlays: vec![ValidationNodeOverlayDto {
                    id: node_id.into(),
                    input_slot_definitions: vec![definition.clone()],
                    output_slot_definitions: vec![definition],
                    ..Default::default()
                }],
                ..Default::default()
            };
            let request = build_active_validation_request(&workflow, &context);
            assert_eq!(has_empty(&request, node_id, "input", 0), !retired);
            assert_eq!(has_empty(&request, node_id, "output", 0), !retired);
            assert!(has_empty(&request, node_id, "input", 1));
            let slots = &request.nodes[1].input_slots;
            assert_eq!(slots.len(), 3);
            assert_eq!(slots[2].key, "retained");
            assert_eq!(slots[2].path, "/bound");
            assert_eq!(slots[2].type_name, "String");
            assert!(request
                .inherited_slot_paths
                .iter()
                .any(|path| path == "outer"));
        }
        assert_eq!(
            workflow.states[1].input_slots[2].inherited.as_deref(),
            Some("/outer")
        );
        assert_eq!(
            workflow.states[1].input_slots[2].description,
            "Authored binding"
        );
        assert_eq!(serialize_scxml(&workflow).unwrap(), saved_before);
    }

    #[test]
    fn retained_connected_slots_still_supply_writers_type_checks_and_path_checks() {
        let mut workflow = workflow_with_duplicate_requests();
        workflow.states[0].input_slots.clear();
        workflow.states[0].output_slots[0].path = "/shared".into();
        workflow.states[1].input_slots = vec![
            Slot {
                key: "text".into(),
                type_name: "Model".into(),
                path: "/shared".into(),
                ..Default::default()
            },
            Slot {
                key: "text".into(),
                type_name: "String".into(),
                path: "/orphan".into(),
                ..Default::default()
            },
            Slot {
                key: "text".into(),
                type_name: "String".into(),
                path: "/outer".into(),
                inherited: Some("/outer".into()),
                ..Default::default()
            },
        ];
        workflow.states[1].output_slots.clear();
        let writer_id = workflow.states[0].id.as_str();
        let reader_id = workflow.states[1].id.as_str();
        let request = build_active_validation_request(
            &workflow,
            &ActiveValidationRequestDto {
                node_overlays: vec![
                    ValidationNodeOverlayDto {
                        id: writer_id.into(),
                        output_slot_definitions: vec![descriptor(0, "String")],
                        ..Default::default()
                    },
                    ValidationNodeOverlayDto {
                        id: reader_id.into(),
                        input_slot_definitions: vec![
                            descriptor(0, "Model"),
                            descriptor(1, "String"),
                            descriptor(2, "String"),
                        ],
                        ..Default::default()
                    },
                ],
                ancestor_writer_slot_paths: vec!["/outer".into()],
                ..Default::default()
            },
        );
        assert!(request.nodes[0].output_slots[0].definition_missing);
        assert!(request.nodes[1]
            .input_slots
            .iter()
            .all(|slot| slot.definition_missing));
        let problems = validate_editor_graph(&request);
        let mismatch = problems
            .iter()
            .find(|problem| problem.title == "Slot type mismatch")
            .unwrap();
        assert_eq!(mismatch.node_id.as_deref(), Some(reader_id));
        assert_eq!(
            mismatch.focus_node_ids,
            vec![writer_id.to_string(), reader_id.to_string()]
        );
        assert!(problems
            .iter()
            .any(|problem| problem.id == "slot-no-writer-orphan"));
        assert!(!problems
            .iter()
            .any(|problem| problem.id == "slot-no-writer-shared"
                || problem.id == "slot-no-writer-outer"
                || problem.id.starts_with("slot-input-empty-")
                || problem.id.starts_with("slot-output-empty-")));
        assert_eq!(request.nodes[1].input_slots[1].path, "/orphan");
    }
}
