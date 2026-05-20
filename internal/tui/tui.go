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

	"github.com/sharperflow/opencode-model-preferences/internal/config"
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
	prefModel   string // model from preferences, or ""
	hasChanged  bool   // true if prefModel differs from target.Model
	advProvider *config.AdvProviderConfig // non-nil for provider ADV variants
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

	if t.prefModel != "" {
		if t.prefModel != t.target.Model {
			prefix := "current"
			if t.target.IsSubagent() {
				prefix = "sticky override"
			}
			return fmt.Sprintf("%s: %s  → pending: %s", prefix, current, t.prefModel)
		}
		if t.target.IsSubagent() {
			return fmt.Sprintf("sticky override: %s", t.prefModel)
		}
		return fmt.Sprintf("model: %s", t.prefModel)
	}
	if t.target.IsSubagent() && t.target.Model != "" {
		return fmt.Sprintf("sticky override: %s", current)
	}
	return fmt.Sprintf("model: %s", current)
}
func (t targetItem) FilterValue() string {
	return t.target.Name + " " + t.target.Model + " " + t.prefModel
}

// pickItem is a selectable option in the model picker.
type pickItem struct {
	label string
	value string // empty string = "clear" option
}

func (p pickItem) Title() string       { return p.label }
func (p pickItem) Description() string { return "" }
func (p pickItem) FilterValue() string { return p.label }

// -- Item builders -----------------------------------------------------------

func buildTargetItems(targets []config.Target, prefs config.PreferencesConfig) []list.Item {
	var agents, subagents, providers []list.Item
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

		prefModel := prefs.TargetModels[t.Name]
		hasChanged := prefModel != "" && prefModel != t.Model
		item := targetItem{target: t, prefModel: prefModel, hasChanged: hasChanged}
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
	viewAssignments viewState = iota // agent list with model assignments
	viewPicker                       // model picker
)

// -- Messages ----------------------------------------------------------------

type applyResultMsg struct{ err error }
type savePrefsMsg struct{ err error }

type modelPickDoneMsg struct {
	targetName string
	model      string
	cleared    bool
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

	status string
	width  int
	height int
}

// New creates the initial TUI model.
func New(state *config.State, prefs config.PreferencesConfig) Model {
	delegate := newDelegate()

	assignmentItems := buildTargetItems(state.Targets, prefs)
	al := list.New(assignmentItems, delegate, 0, 0)
	al.Title = "Model Preferences"
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
		// Picker view: enter selects, esc goes back
		if m.view == viewPicker {
			if m.pickerList.FilterState() == list.Filtering {
				break // let filter handle keys
			}
			switch {
			case key.Matches(msg, key.NewBinding(key.WithKeys("enter"))):
				return m.handlePickerSelect()
			case key.Matches(msg, key.NewBinding(key.WithKeys("esc"))):
				m.view = viewAssignments
				m.status = ""
				return m, nil
			case key.Matches(msg, key.NewBinding(key.WithKeys("q", "ctrl+c"))):
				return m, tea.Quit
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
	return m, func() tea.Msg {
		if value == "" {
			return modelPickDoneMsg{targetName: targetName, cleared: true}
		}
		return modelPickDoneMsg{targetName: targetName, model: value}
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
	prefs := m.prefs
	targets := m.state.Targets
	return m, func() tea.Msg {
		err := config.ApplyPreferences(prefs, targets)
		return applyResultMsg{err: err}
	}
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
		content += "\n" + faintStyle.Render("enter/m: set model  d: clear  D: clear sub-agents  e: toggle enable/disable  a: apply to opencode.json  q: quit")

	case viewPicker:
		content = m.pickerList.View()
		content += "\n" + faintStyle.Render("enter: select  /: filter  esc: cancel")
	}

	return appStyle.Render(content)
}
