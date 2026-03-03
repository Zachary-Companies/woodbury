import Cocoa
import Foundation

// Woodbury Desktop Event Monitor
// Outputs mouse click and keyboard events as JSON lines to stdout.
// Usage: desktop-hook [--include-moves]
// Kill the process (SIGTERM/SIGKILL) to stop.

let includeMoves = CommandLine.arguments.contains("--include-moves")

func output(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        print(str)
        fflush(stdout)
    }
}

// Map special key codes to readable names
func keyName(for keyCode: UInt16, event: NSEvent) -> String {
    switch keyCode {
    case 36: return "enter"
    case 48: return "tab"
    case 49: return "space"
    case 51: return "backspace"
    case 53: return "escape"
    case 117: return "delete"
    case 123: return "left"
    case 124: return "right"
    case 125: return "down"
    case 126: return "up"
    case 115: return "home"
    case 119: return "end"
    case 116: return "pageup"
    case 121: return "pagedown"
    case 122: return "f1"
    case 120: return "f2"
    case 99:  return "f3"
    case 118: return "f4"
    case 96:  return "f5"
    case 97:  return "f6"
    case 98:  return "f7"
    case 100: return "f8"
    case 101: return "f9"
    case 109: return "f10"
    case 103: return "f11"
    case 111: return "f12"
    default:
        // Try to get the character
        if let chars = event.charactersIgnoringModifiers, !chars.isEmpty {
            return chars
        }
        return "unknown_\(keyCode)"
    }
}

// Check accessibility permission
let trusted = AXIsProcessTrustedWithOptions(
    [kAXTrustedCheckOptionPrompt.takeUnretainedValue(): true] as CFDictionary
)

if !trusted {
    output(["type": "error", "message": "Accessibility permission required. A system prompt should appear — grant access and re-run."])
    exit(1)
}

// Build event mask — clicks + keyboard
var mask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .keyDown]
if includeMoves {
    mask.insert(.mouseMoved)
}

// Global event monitor — receives events from ALL applications
let monitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { event in
    let ts = Int(Date().timeIntervalSince1970 * 1000)

    switch event.type {
    case .leftMouseDown, .rightMouseDown:
        let loc = NSEvent.mouseLocation
        let screenHeight = NSScreen.main?.frame.height ?? 0
        let x = Int(loc.x)
        let y = Int(screenHeight - loc.y)

        if event.type == .leftMouseDown {
            let clicks = event.clickCount
            let etype = clicks >= 2 ? "double_click" : "click"
            output(["type": "click", "x": x, "y": y, "button": 1, "clicks": clicks, "action": etype, "time": ts])
        } else {
            output(["type": "click", "x": x, "y": y, "button": 2, "clicks": 1, "action": "right_click", "time": ts])
        }

    case .keyDown:
        let keyCode = event.keyCode
        let key = keyName(for: keyCode, event: event)
        let chars = event.characters ?? ""

        // Build modifiers array
        var modifiers: [String] = []
        if event.modifierFlags.contains(.command) { modifiers.append("cmd") }
        if event.modifierFlags.contains(.control) { modifiers.append("ctrl") }
        if event.modifierFlags.contains(.option)  { modifiers.append("alt") }
        if event.modifierFlags.contains(.shift)   { modifiers.append("shift") }

        // Determine if this is a printable character (for typing) or a special key
        let isModified = !modifiers.isEmpty && !(modifiers == ["shift"])
        let isSpecialKey = keyCode == 36 || keyCode == 48 || keyCode == 49 ||
                          keyCode == 51 || keyCode == 53 || keyCode == 117 ||
                          (keyCode >= 122 && keyCode <= 126) ||
                          keyCode == 115 || keyCode == 119 ||
                          keyCode == 116 || keyCode == 121 ||
                          (keyCode >= 96 && keyCode <= 103) ||
                          keyCode == 109 || keyCode == 111

        if isModified || isSpecialKey {
            // Keyboard shortcut or special key
            output(["type": "keydown", "key": key, "keyCode": keyCode, "modifiers": modifiers, "time": ts])
        } else {
            // Regular character typing
            output(["type": "keypress", "key": key, "chars": chars, "keyCode": keyCode, "time": ts])
        }

    case .mouseMoved:
        let loc = NSEvent.mouseLocation
        let screenHeight = NSScreen.main?.frame.height ?? 0
        output(["type": "move", "x": Int(loc.x), "y": Int(screenHeight - loc.y)])

    default:
        break
    }
}

if monitor == nil {
    output(["type": "error", "message": "Failed to create global event monitor"])
    exit(1)
}

output(["type": "started"])

// NSEvent.addGlobalMonitorForEvents requires NSApplication's event loop
// (not just RunLoop) to actually deliver events to the monitor callback.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // Don't show in Dock
app.run()
