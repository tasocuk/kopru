// Odaklanan öğe yazı alanı olduğunda 1, olmadığında 0 yazar.
import AppKit
import ApplicationServices

let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
var prepared = Set<pid_t>()
var running = true
var last = ""

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

// Chrome ve Brave sayfa içi yazı alanlarını ancak bu ayarlarla bildirir. İlk seferde 2-3 saniye sürebilir.
func prepareFrontmostApp() {
    guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier, !prepared.contains(pid) else { return }
    prepared.insert(pid)
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
}

// Bu ayar pencere animasyonlarını yavaşlatabildiği için oturum bitince geri alınır.
func restoreApps() {
    for pid in prepared {
        AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXEnhancedUserInterface" as CFString, kCFBooleanFalse)
    }
}

// Sistem genelindeki öğe yeni macOS sürümlerinde hata verdiği için öndeki uygulama sorgulanır.
func focusedIsText() -> Bool {
    guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
          let value = attribute(AXUIElementCreateApplication(pid), "AXFocusedUIElement") else { return false }
    let element = value as! AXUIElement
    if let role = attribute(element, "AXRole") as? String, textRoles.contains(role) { return true }
    return attribute(element, "AXEditableAncestor") != nil
}

signal(SIGTERM) { _ in running = false }

while running && getppid() != 1 {
    prepareFrontmostApp()
    let state = focusedIsText() ? "1" : "0"
    if state != last {
        last = state
        print(state)
        fflush(stdout)
    }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25))
}

restoreApps()
