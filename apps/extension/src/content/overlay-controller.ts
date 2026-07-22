import type { BorrowRequestData } from "./BorrowConfirmationOverlay";
import type { HelpRequestData } from "./HelpRequestOverlay";
import type { RecordRequestData } from "./RecordOverlay";

export interface OverlayState {
  borrowRequests: BorrowRequestData[];
  activeHelp: HelpRequestData | null;
  activeRecord: RecordRequestData | null;
  controlVisible: boolean;
  interrupting: boolean;
  activeSessionId: string | null;
  automationBypassCount: number;
  /**
   * After record Finish/Stop clears `activeRecord`, the session is still
   * alive until CLI `session.stop`. Suppress the control mask for that gap
   * so 「Agent 正在控制」does not flash between RecordOverlay and teardown.
   */
  suppressControlAfterRecord: boolean;
}

type MutableOverlayState = Omit<OverlayState, "controlVisible">;

/**
 * Owns overlay state by rendering scope. User-tab overlays survive Agent
 * session teardown; Agent-tab overlays are cleared whenever a tab is returned.
 */
export class OverlayController {
  private state: MutableOverlayState = {
    borrowRequests: [],
    activeHelp: null,
    activeRecord: null,
    interrupting: false,
    activeSessionId: null,
    automationBypassCount: 0,
    suppressControlAfterRecord: false,
  };

  snapshot(): OverlayState {
    return {
      ...this.state,
      controlVisible: this.isControlVisible(),
      borrowRequests: [...this.state.borrowRequests],
    };
  }

  isControlVisible(): boolean {
    return this.state.activeSessionId !== null;
  }

  addBorrowRequest(request: BorrowRequestData): void {
    this.state.borrowRequests = [
      ...this.state.borrowRequests.filter((r) => r.id !== request.id),
      request,
    ];
  }

  removeBorrowRequest(requestId: string): void {
    this.state.borrowRequests = this.state.borrowRequests.filter((r) => r.id !== requestId);
  }

  activateAgentSession(sessionId: string): void {
    this.state.activeSessionId = sessionId;
    this.state.interrupting = false;
  }

  setInterrupting(interrupting: boolean): void {
    if (!this.state.activeSessionId) return;
    this.state.interrupting = interrupting;
  }

  setAgentHelpRequest(request: HelpRequestData): HelpRequestData | null {
    const previous = this.state.activeHelp;
    this.state.activeHelp = request;
    return previous;
  }

  clearAgentHelpRequest(requestId?: string): void {
    if (!this.state.activeHelp) return;
    if (requestId && this.state.activeHelp.id !== requestId) return;
    this.state.activeHelp = null;
  }

  setAgentRecordRequest(request: RecordRequestData): RecordRequestData | null {
    const previous = this.state.activeRecord;
    this.state.activeRecord = request;
    this.state.suppressControlAfterRecord = false;
    return previous;
  }

  clearAgentRecordRequest(requestId?: string): void {
    if (!this.state.activeRecord) return;
    if (requestId && this.state.activeRecord.id !== requestId) return;
    this.state.activeRecord = null;
    // Hide control until session teardown — see OverlayState.suppressControlAfterRecord.
    this.state.suppressControlAfterRecord = true;
    // Record start/rearm may have stacked automation-bypass refs; drop them so a
    // stray ControlOverlay cannot sit with pointer-events:none (page usable,
    // Interrupt unclickable).
    this.state.automationBypassCount = 0;
  }

  setAutomationBypass(enabled: boolean): void {
    if (enabled) {
      this.state.automationBypassCount += 1;
    } else {
      this.state.automationBypassCount = Math.max(0, this.state.automationBypassCount - 1);
    }
  }

  resetAgentOverlays(sessionId: string): HelpRequestData | null {
    if (this.state.activeSessionId && this.state.activeSessionId !== sessionId) {
      return null;
    }
    const previousHelp = this.state.activeHelp;
    this.state = {
      ...this.state,
      activeHelp: null,
      activeRecord: null,
      interrupting: false,
      activeSessionId: null,
      automationBypassCount: 0,
      suppressControlAfterRecord: false,
    };
    return previousHelp;
  }
}

/** Control mask ("Agent 正在控制") must hide while help/record overlays own the chrome. */
export function shouldShowAgentControlOverlay(state: OverlayState): boolean {
  return (
    state.controlVisible &&
    !state.suppressControlAfterRecord &&
    state.activeHelp === null &&
    state.activeRecord === null
  );
}
