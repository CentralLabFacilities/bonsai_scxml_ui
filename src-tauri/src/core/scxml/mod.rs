mod parser;
mod serializer;
mod xml;

pub(crate) use parser::parse_scxml;
pub(crate) use serializer::serialize_scxml;

#[cfg(test)]
mod tests {
    use super::{parse_scxml, serialize_scxml};
    use crate::core::model::StateKind;

    const SAMPLE: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<scxml xmlns="http://www.w3.org/2005/07/scxml"
       xmlns:editor="http://bonsai.cit-ec.uni-bielefeld.de/editor"
       version="1.0"
       initial="ExecSetup">
    <datamodel>
        <data id="answer" expr="'yes'"/>
        <data id="#_SLOTS">
            <slots>
                <slot key="Model" state="vision.Detect#main" xpath="/model"/>
                <inheritSlot key="Speech" state="Talk" xpath="/speech"/>
            </slots>
        </data>
    </datamodel>
    <state id="ExecSetup" initial="Talk">
        <metadata>
            <editor:position x="100" y="200"/>
        </metadata>
        <transition event="Talk.success" target="End"/>
        <state id="Talk">
            <datamodel>
                <data id="text" expr="'Hello'"/>
            </datamodel>
        </state>
    </state>
    <final id="End"/>
</scxml>"##;

    #[test]
    fn parses_core_workflow_semantics() {
        let workflow = parse_scxml(SAMPLE).expect("SCXML should parse");
        assert_eq!(
            workflow.initial_scxml_state_id.as_deref(),
            Some("ExecSetup")
        );
        assert_eq!(workflow.data_model.len(), 1);
        assert_eq!(workflow.slot_declarations.len(), 2);
        assert_eq!(workflow.states.len(), 3);
        assert_eq!(workflow.transitions.len(), 1);

        let compound = workflow
            .states
            .iter()
            .find(|state| state.scxml_id == "ExecSetup")
            .expect("compound state");
        assert_eq!(compound.kind, StateKind::Compound);
        assert_eq!(compound.editor.x, 100.0);
        assert_eq!(compound.initial_child_scxml_id.as_deref(), Some("Talk"));
    }

    #[test]
    fn imports_unmodified_grasp_workflow_with_header_comment_and_nested_states() {
        // Regression for real Bonsai files containing the exact header syntax
        // below. This is a valid XML comment; the SCXML must not be edited.
        let xml = r##"<?xml version="1.0" encoding="UTF-8"?>
<!-->
Will try to pickup the entity in /graspEntity
needs the corresponding spirit in /Spirit
<!-->
<scxml xmlns="http://www.w3.org/2005/07/scxml" version="1.0" initial="Nop#init">
  <datamodel>
    <data id="#_STATE_PREFIX" expr="'de.unibi.citec.clf.bonsai.skills.'"/>
    <data id="#_SLOTS"><slots>
      <inheritSlot key="Language" state="*" xpath="/language"/>
    </slots></data>
  </datamodel>
  <state id="Nop#init">
    <transition event="Nop.fatal" target="GraspWrapper"/>
  </state>
  <state id="GraspWrapper" initial="FindGoodPosition">
    <state id="FindGoodPosition" initial="ecwm.util.GetNavgoalToEntity">
      <state id="ecwm.util.GetNavgoalToEntity">
        <transition event="GetNavgoalToEntity.success.need_move" target="nav.drive.NavigateTo#GraspDistance"/>
      </state>
      <state id="nav.drive.NavigateTo#GraspDistance"/>
    </state>
    <!-- An ordinary internal documentation comment -->
    <state id="error_recovery" src="${ROBOCUP}/behaviors/grasping/error_recovery.xml"/>
  </state>
  <state id="Nop#success">
    <transition event="Nop.fatal"><send event="success.grasped"/></transition>
  </state>
</scxml>"##;

        let parsed = parse_scxml(xml).expect("Unchanged SCXML should import");
        assert_eq!(parsed.initial_scxml_state_id.as_deref(), Some("Nop#init"));
        assert_eq!(parsed.states.len(), 7);
        assert_eq!(parsed.slot_declarations.len(), 1);
        assert!(parsed.states.iter().any(|state| {
            state.scxml_id == "error_recovery"
                && state.source.as_deref() == Some("${ROBOCUP}/behaviors/grasping/error_recovery.xml")
        }));
        assert!(parsed.transitions.iter().any(|transition| {
            transition.target_scxml_id.is_empty()
                && transition.sent_events.first().map(String::as_str) == Some("success.grasped")
        }));
    }

    #[test]
    fn reads_legacy_and_prefixed_editor_metadata_and_writes_only_prefixed() {
        let legacy = SAMPLE;
        let prefixed = legacy
            .replace("<metadata>", "<editor:metadata>")
            .replace("</metadata>", "</editor:metadata>");

        for source in [legacy, prefixed.as_str()] {
            let workflow = parse_scxml(source).expect("both metadata formats must parse");
            let state = workflow
                .states
                .iter()
                .find(|state| state.scxml_id == "ExecSetup")
                .expect("compound state");
            assert_eq!(state.editor.x, 100.0);
            assert_eq!(state.editor.y, 200.0);

            let saved = serialize_scxml(&workflow).expect("save must succeed");
            assert!(saved.contains("<editor:metadata>"));
            assert!(saved.contains("</editor:metadata>"));
            assert!(!saved.contains("<metadata>"));
            let reopened = parse_scxml(&saved).expect("prefixed output must reopen");
            assert_eq!(
                reopened
                    .states
                    .iter()
                    .find(|state| state.scxml_id == "ExecSetup")
                    .unwrap()
                    .editor
                    .x,
                100.0
            );
        }
    }

    #[test]
    fn preserves_duplicate_scxml_ids_with_unique_internal_ids() {
        let workflow = parse_scxml(
            r#"<scxml initial="lookAtFace"><parallel id="P"><state id="lookAtFace" initial="lookAtFace"><state id="lookAtFace"/></state></parallel></scxml>"#,
        )
        .expect("SCXML should parse");

        let matching: Vec<_> = workflow
            .states
            .iter()
            .filter(|state| state.scxml_id == "lookAtFace")
            .collect();
        assert_eq!(matching.len(), 2);
        assert_ne!(matching[0].id, matching[1].id);
    }

    #[test]
    fn serializes_a_parsed_workflow() {
        let workflow = parse_scxml(SAMPLE).expect("SCXML should parse");
        let serialized = serialize_scxml(&workflow).expect("workflow should serialize");
        assert!(serialized.contains("initial=\"ExecSetup\""));
        assert!(serialized.contains("<state id=\"ExecSetup\" initial=\"Talk\">"));
        assert!(serialized.contains("<slot key=\"Model\""));
        assert!(serialized.contains("<inheritSlot key=\"Speech\""));
    }

    #[test]
    fn preserves_targetless_behavior_exit_sends() {
        let workflow = parse_scxml(
            r#"<scxml initial="Nop#exit"><state id="Nop#exit"><transition event="Nop.success"><send event="behavior.success"/></transition></state></scxml>"#,
        )
        .expect("SCXML should parse");

        assert_eq!(workflow.transitions.len(), 1);
        let transition = &workflow.transitions[0];
        assert!(transition.target_scxml_id.is_empty());
        assert_eq!(transition.sent_events, vec!["behavior.success"]);

        let serialized = serialize_scxml(&workflow).expect("workflow should serialize");
        assert!(serialized.contains("<send event=\"behavior.success\"/>"));
        assert!(!serialized.contains("target=\"\""));
    }
}
