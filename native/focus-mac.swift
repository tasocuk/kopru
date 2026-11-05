// Odaklanan öğe yazı alanı olduğunda 1, olmadığında 0 yazar.
import AppKit
import ApplicationServices

let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
var preparedApp: pid_t = 0
var last = ""

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

// Chromium tabanlı uygulamalar erişilebilirlik ağacını ancak istenince açar.
func prepareFrontmostApp() {
    guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier, pid != preparedApp else { return }
    preparedApp = pid
    AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXManualAccessibility" as CFString, kCFBooleanTrue)
}

// Sistem genelindeki öğe yeni macOS sürümlerinde hata verdiği için öndeki uygulama sorgulanır.
func focusedIsText() -> Bool {
    guard let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
          let value = attribute(AXUIElementCreateApplication(pid), "AXFocusedUIElement") else { return false }
    let element = value as! AXUIElement
    if let role = attribute(element, "AXRole") as? String, textRoles.contains(role) { return true }
    return attribute(element, "AXEditableAncestor") != nil
}

while getppid() != 1 {
    prepareFrontmostApp()
    let state = focusedIsText() ? "1" : "0"
    if state != last {
        last = state
        print(state)
        fflush(stdout)
    }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.25))
}
