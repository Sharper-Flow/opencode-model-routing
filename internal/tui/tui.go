// Package tui implements the Bubbletea TUI for per-agent model preferences.
//
// Two views, using bubbles/list for consistent UX:
//   - Assignments view: list of agents with current model assignment.
//     Press 'enter' or 'm' to pick a model, 'a' to apply to opencode.json,
//     'd' to clear a model assignment.
//   - Picker view: full list.Model for selecting a model, with filtering.
//
// Each agent maps directly to a model.
package tui

import (
	"fmt"
	"io"

	"github.com/Sharper-Flow/opencode-model-routing/internal/config"
	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// -- Styles ------------------------------------------------------------------

var (
	appStyle = lipgloss.NewStyle().Padding(1, 2)

	titleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#FFFDF5")).
			Background(lipgloss.Color("#7D56F4")).
			Padding(0, 1)

	statusStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#A6E3A1")).
			Italic(true)

	sectionStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("#7D56F4")).
			Bold(true).
			PaddingTop(1)

	faintStyle = lipgloss.NewStyle().Faint(true)
)

// -- List items --------------------------------------------------------------

// sectionItem is a non-selectable section header.
type sectionItem struct{ label string }

func (s sectionItem) Title() string       { return s.label }
func (s sectionItem) Description() string { return "" }
func (s sectionItem) FilterValue() string { return "" }

// targetItem wraps a config.Target for the assignments list.
type targetItem struct {
	target      config.Target
	stack       RoutingStack              // routing-first primary + fallback view model
	prefModel   string                    // primary model from preferences/routing stack, or ""
	hasChanged  bool                      // true if prefModel differs from target.Model
	cleared     bool                      // true when the pending primary is explicitly cleared
	advProvider *config.AdvProviderConfig // non-nil for provider ADV variants
	chainCount  int                       // count of configured fallback chain entries
}

func (t targetItem) Title() string { return t.target.Name }
func (t targetItem) Description() string {
	// Provider ADV variant display
	if t.advProvider != nil {
		if !t.advProvider.Enabled {
			return "disabled"
		}
		model := t.advProvider.Model
		if model == "" {
			model = t.target.Model
		}
		if model != "" {
			return fmt.Sprintf("enabled  model: %s", model)
		}
		return "enabled"
	}

	current := t.target.Model
	if current == "" {
		if t.target.IsSubagent() {
			current = "(inherits from calling agent/session)"
		} else {
			current = "(no model)"
		}
	}

	pendingPrimary := t.stack.PrimaryModel
	if pendingPrimary == "" && t.prefModel != "" {
		pendingPrimary = t.prefModel
	}

	var base string
	switch {
	case t.cleared:
		base = fmt.Sprintf("primary current: %s  → pending: (cleared)", current)
	case pendingPrimary != "" && pendingPrimary != t.target.Model:
		prefix := "primary current"
		if t.target.IsSubagent() {
			prefix = "sticky override current"
		}
		base = fmt.Sprintf("%s: %s  → pending: %s", prefix, current, pendingPrimary)
	case pendingPrimary != "" && t.target.IsSubagent():
		base = fmt.Sprintf("sticky override: %s", pendingPrimary)
	case pendingPrimary != "":
		base = fmt.Sprintf("primary: %s", pendingPrimary)
	case t.target.IsSubagent() && t.target.Model != "":
		base = fmt.Sprintf("sticky override: %s", current)
	default:
		base = fmt.Sprintf("primary: %s", current)
	}
	if t.chainCount > 0 {
		base = fmt.Sprintf("%s  → +%d fallbacks", base, t.chainCount)
	}
	return base
}
func (t targetItem) FilterValue() string {
	return t.target.Name + " " + t.target.Model + " " + t.prefModel + " " + fmt.Sprint(t.stack.FallbackModels)
}

// pickItem is a selectable option in the model picker.
type pickItem struct {
	label string
	value string // empty string = "clear" option
}

func (p pickItem) Title() string       { return p.label }
func (p pickItem) Description() string { return "" }
func (p pickItem) FilterValue() string { return p.label }

// chainItem is one entry in the fallback chain editor list.
type chainItem struct {
	model string
	pos   int // 1-based display position
}

func (c chainItem) Title() string       { return fmt.Sprintf("%d. %s", c.pos, c.model) }
func (c chainItem) Description() string { return "" }
func (c chainItem) FilterValue() string { return c.model }

func buildChainItems(chain []string) []list.Item {
	items := make([]list.Item, 0, len(chain))
	for i, m := range chain {
		items = append(items, chainItem{model: m, pos: i + 1})
	}
	return items
}

// -- Item builders -----------------------------------------------------------

func buildTargetItems(targets []config.Target, prefs config.PreferencesConfig) []list.Item {
	var agents, subagents, providers []list.Item
	stacks := BuildRoutingStacks(&config.State{Targets: targets}, prefs)
	stacksByName := make(map[string]RoutingStack, len(stacks))
	for _, stack := range stacks {
		stacksByName[stack.TargetName] = stack
	}

	for _, t := range targets {
		if t.Kind != config.KindAgent || !t.IsModelMappable() {
			continue
		}

		// Provider ADV variants go to their own section
		if config.ValidAdvProvider(t.Name) {
			cfg, ok := prefs.AdvProviders[t.Name]
			if !ok {
				cfg = config.AdvProviderConfig{Enabled: false}
			}
			item := targetItem{target: t, advProvider: &cfg}
			providers = append(providers, item)
			continue
		}

		stack, ok := stacksByName[t.Name]
		if !ok {
			continue
		}
		prefModel := stack.PrimaryModel
		hasChanged := prefModel != "" && prefModel != t.Model
		item := targetItem{
			target:     t,
			stack:      stack,
			prefModel:  prefModel,
			hasChanged: hasChanged,
			cleared:    prefs.ClearedModels[t.Name],
			chainCount: len(stack.FallbackModels),
		}
		if t.IsSubagent() {
			subagents = append(subagents, item)
		} else {
			agents = append(agents, item)
		}
	}
	var items []list.Item
	if len(agents) > 0 {
		items = append(items, sectionItem{"Agents"})
		items = append(items, agents...)
	}
	if len(subagents) > 0 {
		items = append(items, sectionItem{"Sub-agents"})
		items = append(items, subagents...)
	}
	if len(providers) > 0 {
		items = append(items, sectionItem{"ADV Provider Agents"})
		items = append(items, providers...)
	}
	return items
}

func buildModelPickItems(models []config.Model) []list.Item {
	items := []list.Item{
		pickItem{label: "(none — clear model)", value: ""},
	}
	for _, mdl := range models {
		items = append(items, pickItem{label: mdl.ID, value: mdl.ID})
	}
	return items
}

// -- Delegate ----------------------------------------------------------------

type itemDelegate struct {
	inner list.DefaultDelegate
}

func newDelegate() itemDelegate {
	return itemDelegate{inner: list.NewDefaultDelegate()}
}

func (d itemDelegate) Height() int                               { return d.inner.Height() }
func (d itemDelegate) Spacing() int                              { return d.inner.Spacing() }
func (d itemDelegate) Update(msg tea.Msg, m *list.Model) tea.Cmd { return d.inner.Update(msg, m) }
func (d itemDelegate) ShortHelp() []key.Binding                  { return d.inner.ShortHelp() }
func (d itemDelegate) FullHelp() [][]key.Binding                 { return d.inner.FullHelp() }

func (d itemDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	if s, ok := item.(sectionItem); ok {
		if m.Width() <= 0 {
			return
		}
		label := ansi.Truncate(s.label, m.Width()-4, "…")
		rendered := sectionStyle.Render("── " + label + " ──")
		fmt.Fprint(w, rendered) //nolint: errcheck
		return
	}
	d.inner.Render(w, m, index, item)
}

// -- Pick delegate (single-line items, no description) -----------------------

type pickDelegate struct{}

func (d pickDelegate) Height() int                             { return 1 }
func (d pickDelegate) Spacing() int                            { return 0 }
func (d pickDelegate) Update(_ tea.Msg, _ *list.Model) tea.Cmd { return nil }
func (d pickDelegate) ShortHelp() []key.Binding                { return nil }
func (d pickDelegate) FullHelp() [][]key.Binding               { return nil }

func (d pickDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	pi, ok := item.(pickItem)
	if !ok {
		return
	}
	cursor := "  "
	style := lipgloss.NewStyle()
	if index == m.Index() {
		cursor = "> "
		style = style.Foreground(lipgloss.Color("#7D56F4")).Bold(true)
	}
	label := pi.label
	if m.Width() > 4 {
		label = ansi.Truncate(label, m.Width()-4, "…")
	}
	fmt.Fprint(w, cursor+style.Render(label)) //nolint: errcheck
}

// -- View state --------------------------------------------------------------

type viewState int

const (
	viewAssignments    viewState = iota // agent list with model assignments
	viewPicker                          // model picker
	viewFallbackEditor                  // fallback chain editor for selected target
	viewPreview                         // preview config mutations before apply
)

// -- Messages ----------------------------------------------------------------

type applyResultMsg struct{ err error }
type savePrefsMsg struct{ err error }

type modelPickDoneMsg struct {
	targetName string
	model      string
	cleared    bool
	fromEditor bool // true when picker was opened from fallback chain editor
}

// -- Model -------------------------------------------------------------------

// Model is the top-level Bubbletea model.
type Model struct {
	state *config.State
	prefs config.PreferencesConfig
	view  viewState

	assignmentList list.Model
	pickerList     list.Model

	// picker context
	pickerTargetName string

	// fallback chain editor state
	fallbackEditorList       list.Model
	fallbackEditorTargetName string
	fallbackEditorPrimary    string
	fallbackEditorFromEditor bool // true when picker opened from editor

	// preview-before-apply state
	previewPlan config.ApplyPlan
	previewText string

	status string
	width  int
	height int
}

// New creates the initial TUI model.
func New(state *config.State, prefs config.PreferencesConfig) Model {
	delegate := newDelegate()

	assignmentItems := buildTargetItems(state.Targets, prefs)
	al := list.New(assignmentItems, delegate, 0, 0)
	al.Title = "Routing Stacks"
	al.Styles.Title = titleStyle
	al.SetShowStatusBar(true)
	al.SetFilteringEnabled(true)

	// Picker starts empty; populated when opened
	pl := list.New(nil, pickDelegate{}, 0, 0)
	pl.Styles.Title = titleStyle
	pl.SetShowStatusBar(true)
	pl.SetFilteringEnabled(true)

	return Model{
		state:          state,
		prefs:          prefs,
		view:           viewAssignments,
		assignmentList: al,
		pickerList:     pl,
	}
}

func (m Model) Init() tea.Cmd {
	return nil
}

// -- Update ------------------------------------------------------------------

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		h, v := appStyle.GetFrameSize()
		m.assignmentList.SetSize(msg.Width-h, msg.Height-v)
		m.pickerList.SetSize(msg.Width-h, msg.Height-v)
		return m, nil

	case applyResultMsg:
		if msg.err != nil {
			m.status = fmt.Sprintf("Error applying: %v", msg.err)
		} else {
			m.status = "Preferences applied to opencode.json"
		}
		return m, nil

	case savePrefsMsg:
		if msg.err != nil {
			m.status = fmt.Sprintf("Error saving: %v", msg.err)
		}
		return m, nil

	case modelPickDoneMsg:
		// Picker opened from the fallback chain editor: append the chosen
		// model to the chain (or no-op on cleared/clear-pick). Returning
		// to viewFallbackEditor keeps the user inside the editor.
		if msg.fromEditor {
			if !msg.cleared && msg.model != "" {
				if m.prefs.TargetFallbacks == nil {
					m.prefs.TargetFallbacks = make(map[string][]string)
				}
				chain := append([]string{}, m.prefs.TargetFallbacks[msg.targetName]...)
				for _, existing := range chain {
					if existing == msg.model {
						m.status = fmt.Sprintf("%s is already in %s fallback chain", msg.model, msg.targetName)
						m.view = viewFallbackEditor
						return m, nil
					}
				}
				if len(chain) >= config.MaxChainLength {
					m.status = fmt.Sprintf("Fallback chain for %s already has max %d entries", msg.targetName, config.MaxChainLength)
					m.view = viewFallbackEditor
					return m, nil
				}
				chain = append(chain, msg.model)
				if err := config.ValidateFallbackChain(chain); err != nil {
					m.status = fmt.Sprintf("Invalid fallback chain: %v", err)
					m.view = viewFallbackEditor
					return m, nil
				}
				m.prefs.TargetFallbacks[msg.targetName] = chain
				m.fallbackEditorList.SetItems(buildChainItems(chain))
				m.fallbackEditorList.Select(len(chain) - 1)
				m.status = fmt.Sprintf("Added %s to %s fallback chain", msg.model, msg.targetName)
			}
			m.view = viewFallbackEditor
			return m, m.savePrefsCmd()
		}
		if config.ValidAdvProvider(msg.targetName) {
			if m.prefs.AdvProviders == nil {
				m.prefs.AdvProviders = make(map[string]config.AdvProviderConfig)
			}
			cfg := m.prefs.AdvProviders[msg.targetName]
			if msg.cleared {
				cfg.Model = ""
				m.status = fmt.Sprintf("Cleared model for %s", msg.targetName)
			} else {
				cfg.Model = msg.model
				m.status = fmt.Sprintf("Set %s → %s", msg.targetName, msg.model)
			}
			m.prefs.AdvProviders[msg.targetName] = cfg
			m.view = viewAssignments
			m.rebuildAssignmentList()
			return m, m.savePrefsCmd()
		}
		if m.prefs.TargetModels == nil {
			m.prefs.TargetModels = make(map[string]string)
		}
		if m.prefs.ClearedModels == nil {
			m.prefs.ClearedModels = make(map[string]bool)
		}
		if msg.cleared {
			delete(m.prefs.TargetModels, msg.targetName)
			m.prefs.ClearedModels[msg.targetName] = true
			m.status = fmt.Sprintf("Cleared model for %s", msg.targetName)
		} else {
			m.prefs.TargetModels[msg.targetName] = msg.model
			delete(m.prefs.ClearedModels, msg.targetName)
			m.status = fmt.Sprintf("Set %s → %s", msg.targetName, msg.model)
		}
		m.view = viewAssignments
		m.rebuildAssignmentList()
		return m, m.savePrefsCmd()

	case tea.KeyMsg:
		// Preview view: confirm applies, esc returns to routing stacks.
		if m.view == viewPreview {
			switch {
			case key.Matches(msg, key.NewBinding(key.WithKeys("q", "ctrl+c"))):
				return m, tea.Quit
			case key.Matches(msg, key.NewBinding(key.WithKeys("esc"))):
				m.view = viewAssignments
				m.status = ""
				return m, nil
			case key.Matches(msg, key.NewBinding(key.WithKeys("enter", "c"))):
				return m.confirmApplyPreferences()
			}
			return m, nil
		}

		// Picker view: enter selects, esc goes back
		if m.view == viewPicker {
			if m.pickerList.FilterState() == list.Filtering {
				break // let filter handle keys
			}
			switch {
			case key.Matches(msg, key.NewBinding(key.WithKeys("enter"))):
				return m.handlePickerSelect()
			case key.Matches(msg, key.NewBinding(key.WithKeys("esc"))):
				// If picker was opened from the chain editor, return to it
				// rather than to assignments.
				if m.fallbackEditorFromEditor {
					m.fallbackEditorFromEditor = false
					m.view = viewFallbackEditor
				} else {
					m.view = viewAssignments
				}
				m.status = ""
				return m, nil
			case key.Matches(msg, key.NewBinding(key.WithKeys("q", "ctrl+c"))):
				return m, tea.Quit
			}
			break
		}

		// Fallback chain editor view.
		if m.view == viewFallbackEditor {
			if m.fallbackEditorList.FilterState() == list.Filtering {
				break
			}
			switch {
			case key.Matches(msg, key.NewBinding(key.WithKeys("q", "ctrl+c"))):
				return m, tea.Quit
			case key.Matches(msg, key.NewBinding(key.WithKeys("esc"))):
				return m.exitFallbackEditor()
			case key.Matches(msg, key.NewBinding(key.WithKeys("d"))):
				return m.removeFallbackEntry()
			case key.Matches(msg, key.NewBinding(key.WithKeys("K"))):
				return m.moveFallbackEntry(-1)
			case key.Matches(msg, key.NewBinding(key.WithKeys("J"))):
				return m.moveFallbackEntry(+1)
			case key.Matches(msg, key.NewBinding(key.WithKeys("enter"))):
				return m.openFallbackEntryPicker()
			}
			break
		}

		if m.assignmentList.FilterState() == list.Filtering {
			break
		}

		switch {
		case key.Matches(msg, key.NewBinding(key.WithKeys("q", "ctrl+c"))):
			return m, tea.Quit

		case key.Matches(msg, key.NewBinding(key.WithKeys("esc"))):
			return m, tea.Quit

		case key.Matches(msg, key.NewBinding(key.WithKeys("enter", "m"))):
			return m.openModelPicker()

		case key.Matches(msg, key.NewBinding(key.WithKeys("d"))):
			return m.clearModel()

		case key.Matches(msg, key.NewBinding(key.WithKeys("D"))):
			return m.clearSubagentOverrides()

		case key.Matches(msg, key.NewBinding(key.WithKeys("e"))):
			return m.toggleProvider()

		case key.Matches(msg, key.NewBinding(key.WithKeys("f"))):
			return m.openFallbackEditor()

		case key.Matches(msg, key.NewBinding(key.WithKeys("a"))):
			return m.applyPreferences()
		}
	}

	// Delegate to active view
	var cmd tea.Cmd
	switch m.view {
	case viewAssignments:
		m.assignmentList, cmd = m.assignmentList.Update(msg)
	case viewPicker:
		m.pickerList, cmd = m.pickerList.Update(msg)
	case viewFallbackEditor:
		m.fallbackEditorList, cmd = m.fallbackEditorList.Update(msg)
	case viewPreview:
		return m, nil
	}
	return m, cmd
}

// openModelPicker opens a list picker to assign a model to the selected target.
func (m Model) openModelPicker() (tea.Model, tea.Cmd) {
	item, ok := m.assignmentList.SelectedItem().(targetItem)
	if !ok {
		return m, nil
	}

	items := buildModelPickItems(m.state.Models)
	m.pickerList.SetItems(items)
	m.pickerList.Title = fmt.Sprintf("Model for %s", item.target.Name)
	m.pickerList.ResetFilter()
	m.pickerList.Select(0)

	m.pickerTargetName = item.target.Name
	m.view = viewPicker
	m.status = ""
	return m, nil
}

func (m Model) handlePickerSelect() (tea.Model, tea.Cmd) {
	item, ok := m.pickerList.SelectedItem().(pickItem)
	if !ok {
		return m, nil
	}

	targetName := m.pickerTargetName
	value := item.value
	fromEditor := m.fallbackEditorFromEditor
	// Consume the flag — handler decides what to do with it; subsequent
	// pickers from assignments view should not be misclassified.
	m.fallbackEditorFromEditor = false
	return m, func() tea.Msg {
		if value == "" {
			return modelPickDoneMsg{targetName: targetName, cleared: true, fromEditor: fromEditor}
		}
		return modelPickDoneMsg{targetName: targetName, model: value, fromEditor: fromEditor}
	}
}

func (m Model) clearModel() (tea.Model, tea.Cmd) {
	item, ok := m.assignmentList.SelectedItem().(targetItem)
	if !ok {
		return m, nil
	}

	if item.advProvider != nil {
		if m.prefs.AdvProviders == nil {
			m.prefs.AdvProviders = make(map[string]config.AdvProviderConfig)
		}
		cfg := m.prefs.AdvProviders[item.target.Name]
		cfg.Model = ""
		m.prefs.AdvProviders[item.target.Name] = cfg
		m.status = fmt.Sprintf("Cleared model for %s", item.target.Name)
		m.rebuildAssignmentList()
		return m, m.savePrefsCmd()
	}

	if m.prefs.TargetModels == nil {
		m.prefs.TargetModels = make(map[string]string)
	}
	if m.prefs.ClearedModels == nil {
		m.prefs.ClearedModels = make(map[string]bool)
	}
	delete(m.prefs.TargetModels, item.target.Name)
	m.prefs.ClearedModels[item.target.Name] = true
	m.status = fmt.Sprintf("Cleared model for %s", item.target.Name)
	m.rebuildAssignmentList()
	return m, m.savePrefsCmd()
}

func (m Model) clearSubagentOverrides() (tea.Model, tea.Cmd) {
	if m.prefs.TargetModels == nil {
		m.prefs.TargetModels = make(map[string]string)
	}
	if m.prefs.ClearedModels == nil {
		m.prefs.ClearedModels = make(map[string]bool)
	}

	cleared := 0
	for _, target := range m.state.Targets {
		if !target.IsSubagent() {
			continue
		}
		delete(m.prefs.TargetModels, target.Name)
		m.prefs.ClearedModels[target.Name] = true
		cleared++
	}

	if cleared == 0 {
		m.status = "No sub-agent overrides to clear"
		return m, nil
	}

	m.status = fmt.Sprintf("Cleared %d sub-agent override(s)", cleared)
	m.rebuildAssignmentList()
	return m, m.savePrefsCmd()
}

func (m Model) toggleProvider() (tea.Model, tea.Cmd) {
	item, ok := m.assignmentList.SelectedItem().(targetItem)
	if !ok || item.advProvider == nil {
		return m, nil
	}

	if m.prefs.AdvProviders == nil {
		m.prefs.AdvProviders = make(map[string]config.AdvProviderConfig)
	}

	cfg := m.prefs.AdvProviders[item.target.Name]
	cfg.Enabled = !cfg.Enabled
	m.prefs.AdvProviders[item.target.Name] = cfg

	status := "disabled"
	if cfg.Enabled {
		status = "enabled"
	}
	m.status = fmt.Sprintf("%s %s", item.target.Name, status)
	m.rebuildAssignmentList()
	return m, m.savePrefsCmd()
}

func (m Model) applyPreferences() (tea.Model, tea.Cmd) {
	plan, err := config.BuildPreferencesApplyPlan(m.prefs, m.state.Targets)
	if err != nil {
		m.status = fmt.Sprintf("Error building preview: %v", err)
		return m, nil
	}
	m.previewPlan = plan
	m.previewText = plan.Preview()
	m.view = viewPreview
	m.status = ""
	return m, nil
}

func (m Model) confirmApplyPreferences() (tea.Model, tea.Cmd) {
	prefs := m.prefs
	targets := m.state.Targets
	return m, func() tea.Msg {
		err := config.ApplyPreferences(prefs, targets)
		return applyResultMsg{err: err}
	}
}

// -- Fallback chain editor handlers ------------------------------------------

func (m Model) openFallbackEditor() (tea.Model, tea.Cmd) {
	item, ok := m.assignmentList.SelectedItem().(targetItem)
	if !ok {
		return m, nil
	}
	if !item.target.IsModelMappable() {
		m.status = fmt.Sprintf("Fallback chains are not applicable for %s", item.target.Name)
		return m, nil
	}

	if m.prefs.TargetFallbacks == nil {
		m.prefs.TargetFallbacks = make(map[string][]string)
	}
	chain := m.prefs.TargetFallbacks[item.target.Name]
	if chain == nil {
		// Seed from discovered chain if preferences have no entry.
		chain = append([]string{}, item.target.FallbackModels...)
	}

	delegate := newDelegate()
	editorList := list.New(buildChainItems(chain), delegate, 0, 0)
	editorList.Title = fmt.Sprintf("Fallback chain for %s", item.target.Name)
	editorList.Styles.Title = titleStyle
	editorList.SetShowStatusBar(false)
	editorList.SetFilteringEnabled(false)
	if m.width > 0 && m.height > 0 {
		h, v := appStyle.GetFrameSize()
		editorList.SetSize(m.width-h, m.height-v)
	}

	m.fallbackEditorList = editorList
	m.fallbackEditorTargetName = item.target.Name
	m.fallbackEditorPrimary = item.stack.PrimaryModel
	if m.fallbackEditorPrimary == "" {
		m.fallbackEditorPrimary = item.target.Model
	}
	m.prefs.TargetFallbacks[item.target.Name] = chain
	m.view = viewFallbackEditor
	m.status = ""
	return m, nil
}

func (m Model) exitFallbackEditor() (tea.Model, tea.Cmd) {
	m.view = viewAssignments
	m.rebuildAssignmentList()
	return m, m.savePrefsCmd()
}

func (m Model) removeFallbackEntry() (tea.Model, tea.Cmd) {
	idx := m.fallbackEditorList.Index()
	chain := m.prefs.TargetFallbacks[m.fallbackEditorTargetName]
	if idx < 0 || idx >= len(chain) {
		return m, nil
	}
	chain = append(chain[:idx], chain[idx+1:]...)
	m.prefs.TargetFallbacks[m.fallbackEditorTargetName] = chain
	m.fallbackEditorList.SetItems(buildChainItems(chain))
	if len(chain) > 0 && idx >= len(chain) {
		m.fallbackEditorList.Select(len(chain) - 1)
	}
	return m, m.savePrefsCmd()
}

func (m Model) moveFallbackEntry(delta int) (tea.Model, tea.Cmd) {
	idx := m.fallbackEditorList.Index()
	chain := m.prefs.TargetFallbacks[m.fallbackEditorTargetName]
	newIdx := idx + delta
	if idx < 0 || idx >= len(chain) || newIdx < 0 || newIdx >= len(chain) {
		return m, nil
	}
	chain[idx], chain[newIdx] = chain[newIdx], chain[idx]
	m.prefs.TargetFallbacks[m.fallbackEditorTargetName] = chain
	m.fallbackEditorList.SetItems(buildChainItems(chain))
	m.fallbackEditorList.Select(newIdx)
	return m, m.savePrefsCmd()
}

func (m Model) openFallbackEntryPicker() (tea.Model, tea.Cmd) {
	// Open the model picker scoped to the editor; result is appended to the
	// chain on return (handled in handlePickerSelect via the
	// fallbackEditorFromEditor flag).
	items := buildModelPickItems(m.state.Models)
	m.pickerList.SetItems(items)
	m.pickerList.Title = fmt.Sprintf("Add to chain for %s", m.fallbackEditorTargetName)
	m.pickerList.ResetFilter()
	m.pickerList.Select(0)
	m.pickerTargetName = m.fallbackEditorTargetName
	m.fallbackEditorFromEditor = true
	m.view = viewPicker
	m.status = ""
	return m, nil
}

func (m Model) savePrefsCmd() tea.Cmd {
	prefs := m.prefs
	return func() tea.Msg {
		err := config.SavePreferences(prefs)
		return savePrefsMsg{err: err}
	}
}

func (m *Model) rebuildAssignmentList() {
	items := buildTargetItems(m.state.Targets, m.prefs)
	m.assignmentList.SetItems(items)
}

func (m Model) providerFilesWarning() string {
	seen := make(map[string]bool)
	for _, target := range m.state.Targets {
		if config.ValidAdvProvider(target.Name) {
			seen[target.Name] = true
		}
	}
	missing := 0
	for _, name := range []string{"adv-claude", "adv-gpt", "adv-glm", "adv-kimi"} {
		if !seen[name] {
			missing++
		}
	}
	if missing == 0 {
		return ""
	}
	return fmt.Sprintf("Warning: %d ADV provider agent file(s) missing from global agents. Run ADV sync-global.sh --fix.", missing)
}

// -- View --------------------------------------------------------------------

func (m Model) View() string {
	var content string

	switch m.view {
	case viewAssignments:
		content = m.assignmentList.View()
		if m.status != "" {
			content += "\n" + statusStyle.Render(m.status)
		}
		if warning := m.providerFilesWarning(); warning != "" {
			content += "\n" + faintStyle.Render(warning)
		}
		content += "\n" + faintStyle.Render("Sub-agent models are sticky overrides; press D to clear all sub-agent overrides.")
		content += "\n" + faintStyle.Render("enter/m: set model/primary  d: clear primary  D: clear sub-agents  e: toggle enable/disable  f: edit fallback chain  a: apply to opencode.json  q: quit")

	case viewPicker:
		content = m.pickerList.View()
		content += "\n" + faintStyle.Render("enter: select  /: filter  esc: cancel")

	case viewFallbackEditor:
		primary := m.fallbackEditorPrimary
		if primary == "" {
			primary = "(no model)"
		}
		content = fmt.Sprintf("Routing stack: %s\nPrimary: %s\n", m.fallbackEditorTargetName, primary)
		content += m.fallbackEditorList.View()
		if m.status != "" {
			content += "\n" + statusStyle.Render(m.status)
		}
		content += "\n" + faintStyle.Render("enter: add model  d: remove  K: move up  J: move down  esc: back  q: quit")

	case viewPreview:
		content = titleStyle.Render("Preview config changes")
		content += "\n" + m.previewText
		if m.status != "" {
			content += "\n" + statusStyle.Render(m.status)
		}
		content += "\n" + faintStyle.Render("enter/c: confirm apply  esc: back  q: quit")
	}

	return appStyle.Render(content)
}
