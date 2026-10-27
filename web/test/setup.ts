import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Globals are off, so Testing Library cannot register its own cleanup: unmount after every test here.
afterEach(() => cleanup());
