use crate::{
    AdapterError, WindowInfo,
    adapter::{ActionOps, InputOps, NativeHandle, ObservationOps, SystemOps, WindowFilter},
    locator::live_locator::{
        IdentifierEvidence, LocatorEvidence, LocatorField, LocatorRefEvidence, LocatorStats,
        ObservationRequest, ObservationRoot, ObservationSource, ObservedSubtree, ObservedTree,
    },
};

pub(crate) const FRAMED_LABEL: &str = "FramedLabel";
pub(crate) const TOKEN_ROOT: &str = "axtok1:find-root";
pub(crate) const TOKEN_ROOT_NAME: &str = "Root";

pub(crate) fn framed_label_screen_bounds() -> crate::Rect {
    crate::Rect {
        x: 214.0,
        y: 202.0,
        width: 177.0,
        height: 18.0,
    }
}

fn framed_label_window_bounds() -> crate::Rect {
    crate::Rect {
        x: 48.0,
        y: 70.0,
        width: 177.0,
        height: 18.0,
    }
}

pub(crate) struct LiveFindAdapter {
    structurally_complete: bool,
    framed_label: bool,
    token_root: bool,
    token_matches: bool,
    unread_member: bool,
    window_reads: std::sync::atomic::AtomicUsize,
}

impl LiveFindAdapter {
    pub(crate) fn complete() -> Self {
        Self {
            structurally_complete: true,
            framed_label: false,
            token_root: false,
            token_matches: false,
            unread_member: false,
            window_reads: Default::default(),
        }
    }

    pub(crate) fn incomplete() -> Self {
        Self {
            structurally_complete: false,
            ..Self::complete()
        }
    }

    pub(crate) fn with_framed_label() -> Self {
        Self {
            framed_label: true,
            ..Self::complete()
        }
    }

    /// A window whose root element carries an element token while the elements
    /// inside it carry none.
    pub(crate) fn with_token_root() -> Self {
        Self {
            token_root: true,
            ..Self::complete()
        }
    }

    /// A token root whose inner elements carry tokens too.
    pub(crate) fn with_token_root_and_matches() -> Self {
        Self {
            token_matches: true,
            ..Self::with_token_root()
        }
    }

    /// A token root whose matches carry tokens beside a tokenless member whose
    /// actions are still unread, which hydration could make publishable.
    pub(crate) fn with_token_root_and_unread_member() -> Self {
        Self {
            unread_member: true,
            ..Self::with_token_root_and_matches()
        }
    }

    pub(crate) fn window_reads(&self) -> usize {
        self.window_reads.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn button(&self, name: &str) -> LocatorEvidence {
        let mut evidence = Self::evidence("button", Some(name));
        if self.token_matches {
            evidence.identifiers =
                IdentifierEvidence::absent().with_retained_object(format!("axtok1:{name}"));
        }
        evidence
    }

    fn evidence(role: &str, name: Option<&str>) -> LocatorEvidence {
        LocatorEvidence {
            role: LocatorField::Known(role.into()),
            name: name
                .map(|value| LocatorField::Known(value.into()))
                .unwrap_or(LocatorField::Absent),
            description: LocatorField::Absent,
            value: LocatorField::Absent,
            identifiers: IdentifierEvidence::absent(),
            states: LocatorField::Known(Vec::new()),
            ref_evidence: LocatorRefEvidence {
                window_bounds: LocatorField::Absent,
                bounds: LocatorField::Absent,
                available_actions: LocatorField::Known(Vec::new()),
                descriptors: Default::default(),
            },
        }
    }

    fn node(&self, evidence: LocatorEvidence, children: Vec<ObservedSubtree>) -> ObservedSubtree {
        ObservedSubtree::new(evidence, children, self.structurally_complete, None)
    }
}

impl ObservationOps for LiveFindAdapter {
    fn observe_tree(
        &self,
        root: ObservationRoot<'_>,
        request: &ObservationRequest,
    ) -> Result<ObservedTree, AdapterError> {
        if let ObservationRoot::Element { entry, .. } = &root {
            let own = Self::evidence(&entry.identity.role, entry.identity.name.as_deref());
            let mut children = if self.token_root {
                vec![self.node(self.button("OnlyInWindowTwo"), Vec::new())]
            } else {
                Vec::new()
            };
            if self.unread_member {
                let mut member = Self::evidence("group", Some("Unread"));
                member.ref_evidence.available_actions = LocatorField::Unknown;
                children.push(self.node(member, Vec::new()));
            }
            return ObservedTree::from_roots(
                vec![self.node(own, children)],
                ObservationSource::from_root(&root, request.surface),
                LocatorStats::default(),
                self.structurally_complete,
            );
        }
        let ObservationRoot::Window(window) = &root else {
            return Err(AdapterError::internal("expected locator root"));
        };
        let window = *window;
        self.window_reads
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let marker = if window.id == "w-2" {
            "OnlyInWindowTwo"
        } else {
            "OnlyInWindowOne"
        };
        let mut children = vec![self.node(self.button(marker), Vec::new())];
        if self.framed_label {
            let mut label = Self::evidence("statictext", Some(FRAMED_LABEL));
            label.ref_evidence.bounds = LocatorField::Known(framed_label_screen_bounds());
            label.ref_evidence.window_bounds = LocatorField::Known(framed_label_window_bounds());
            children.push(self.node(label, Vec::new()));
        }
        if self.token_root {
            let mut token_root = Self::evidence("group", Some(TOKEN_ROOT_NAME));
            token_root.identifiers =
                IdentifierEvidence::absent().with_retained_object(TOKEN_ROOT.into());
            children = vec![self.node(token_root, children)];
        }
        let root_node = self.node(Self::evidence("window", Some(&window.title)), children);
        ObservedTree::from_roots(
            vec![root_node],
            ObservationSource::from_root(&root, request.surface),
            LocatorStats::default(),
            self.structurally_complete,
        )
    }

    fn list_windows(
        &self,
        _filter: &WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![
            WindowInfo {
                id: "w-1".into(),
                title: "First".into(),
                app: "FixtureApp".into(),
                pid: crate::ProcessId::new(101),
                process_instance: Some("test-instance".into()),
                bounds: None,
                state: crate::WindowState {
                    is_focused: true,
                    ..Default::default()
                },
            },
            WindowInfo {
                id: "w-2".into(),
                title: "Second".into(),
                app: "FixtureApp".into(),
                pid: crate::ProcessId::new(102),
                process_instance: Some("test-instance".into()),
                bounds: None,
                state: crate::WindowState {
                    is_focused: false,
                    ..Default::default()
                },
            },
        ])
    }

    fn resolve_element_strict(
        &self,
        _entry: &crate::refs::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }

    fn resolve_locator_anchor(
        &self,
        _entry: &crate::refs::RefEntry,
        _deadline: crate::Deadline,
    ) -> Result<NativeHandle, AdapterError> {
        Ok(NativeHandle::null())
    }
}

impl ActionOps for LiveFindAdapter {}

impl InputOps for LiveFindAdapter {}
impl SystemOps for LiveFindAdapter {
    fn supported_surfaces(&self) -> Vec<crate::SnapshotSurface> {
        vec![crate::SnapshotSurface::Window]
    }
}
