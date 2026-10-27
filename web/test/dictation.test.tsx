import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Dictation, insertSpoken, spoken } from "../src/dictation";
import { LangContext } from "../src/i18n";

// Voice typing: what is said lands at the caret of the focused field as if it were typed, with spoken
// punctuation, and React's onChange sees it.

describe("spoken punctuation", () => {
  test("Turkish words for marks become the marks, whole words only", () => {
    expect(spoken("merhaba virgül nasılsın soru işareti", "tr")).toBe("merhaba, nasılsın?");
    expect(spoken("birinci madde yeni satır ikinci madde nokta", "tr")).toBe("birinci madde\nikinci madde.");
    expect(spoken("iki nokta üst üste değil noktalar", "tr")).toBe(": üst üste değil noktalar");
    expect(spoken("new line done period", "en")).toBe("\ndone.");
  });

  test("a sentence starts with a capital (Turkish i becomes İ) and words are spaced", () => {
    const el = document.createElement("textarea");
    insertSpoken(el, "istanbul toplantısı", "tr");
    expect(el.value).toBe("İstanbul toplantısı");
    insertSpoken(el, "yarın", "tr");
    expect(el.value).toBe("İstanbul toplantısı yarın");
    insertSpoken(el, ".", "tr");
    insertSpoken(el, "sonra", "tr");
    expect(el.value).toBe("İstanbul toplantısı yarın. Sonra");
  });
});

class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  constructor() {
    FakeRecognition.last = this;
  }
  say(text: string, isFinal = true) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
  }
}

function Form() {
  const [text, setText] = useState("");
  return (
    <LangContext.Provider value={{ lang: "tr", setLang: () => {} }}>
      <textarea aria-label="Not" className="textarea" value={text} onChange={(e) => setText(e.target.value)} />
      <output data-testid="state">{text}</output>
      <Dictation />
    </LangContext.Provider>
  );
}

describe("Dictation", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
    FakeRecognition.last = null;
  });

  test("no speech recognition in the browser, no button", () => {
    render(<Form />);
    act(() => screen.getByLabelText("Not").focus());
    expect(screen.queryByRole("button", { name: "Sesle yaz" })).toBeNull();
  });

  test("the focused field gets a mic; speech goes into it and through onChange", () => {
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition;
    render(<Form />);
    const field = screen.getByLabelText("Not") as HTMLTextAreaElement;
    act(() => field.focus());
    const mic = screen.getByRole("button", { name: "Sesle yaz" });
    fireEvent.click(mic);
    const rec = FakeRecognition.last!;
    expect(rec.start).toHaveBeenCalled();
    expect(rec.lang).toBe("tr-TR");
    expect(screen.getByRole("button", { name: "Sesle yazmayı durdur" }).getAttribute("aria-pressed")).toBe("true");

    act(() => rec.say("merhaba dün", false)); // interim: shown, not typed
    expect(field.value).toBe("");
    act(() => rec.say("merhaba dünya virgül nasılsın"));
    expect(field.value).toBe("Merhaba dünya, nasılsın");
    expect(screen.getByTestId("state").textContent).toBe("Merhaba dünya, nasılsın");

    act(() => {
      fireEvent.keyDown(field, { key: "Escape" });
    });
    expect(rec.stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sesle yaz" })).toBeTruthy();
  });

  test("passwords and numbers get no mic", () => {
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition;
    render(
      <LangContext.Provider value={{ lang: "en", setLang: () => {} }}>
        <input aria-label="pw" type="password" />
        <Dictation />
      </LangContext.Provider>,
    );
    act(() => screen.getByLabelText("pw").focus());
    expect(screen.queryByRole("button", { name: "Type by voice" })).toBeNull();
  });
});
