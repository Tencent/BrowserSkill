import { type RenderedRef, renderVom, type VomOptions } from "@browser-skill/vom";
import type { CdpAxNode } from "./observation";
import { buildVomScene } from "./observation";
import type { CdpRunner } from "./shared";
import {
  type CapturedNode,
  type CapturedSurfaceProbe,
  type CapturedViewModel,
  captureViewModel,
  collectOverlayExcludedBackendIds,
} from "./vom/capture";

export interface CaptureVomObservationOptions extends VomOptions {
  conditionalSurfaceProbe?: boolean;
  hoverProbeBypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>;
}

export interface CaptureVomObservationResult {
  text: string;
  refs: RenderedRef[];
  truncated: boolean;
  captured: CapturedNode[];
  surfaceProbes?: CapturedSurfaceProbe[];
}

function emptyCapturedViewModel(viewport = { width: 0, height: 0 }): CapturedViewModel {
  return { viewport, nodes: [], iframeNodes: new Map(), excludedBackendNodeIds: new Set() };
}

interface LayoutMetricsViewportReply {
  cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
  layoutViewport?: { clientWidth?: number; clientHeight?: number };
}

async function fallbackCapturedViewModel(
  cdp: CdpRunner,
  tabId: number,
): Promise<CapturedViewModel> {
  let viewport = { width: 0, height: 0 };
  try {
    const metrics = await cdp.send<LayoutMetricsViewportReply>(tabId, "Page.getLayoutMetrics", {});
    const vpSrc = metrics.cssLayoutViewport ?? metrics.layoutViewport ?? {};
    viewport = {
      width: vpSrc.clientWidth ?? 0,
      height: vpSrc.clientHeight ?? 0,
    };
  } catch {
    // viewport stays zero-sized
  }
  const excludedBackendNodeIds = await collectOverlayExcludedBackendIds(cdp, tabId);
  return { ...emptyCapturedViewModel(viewport), excludedBackendNodeIds };
}

async function captureForVom(
  cdp: CdpRunner,
  tabId: number,
  conditionalSurfaceProbe: boolean,
  hoverProbeBypassOverlay?: (tabId: number, enabled: boolean) => Promise<void>,
): Promise<CapturedViewModel> {
  try {
    return await captureViewModel(cdp, tabId, {
      conditionalSurfaceProbe,
      hoverProbeBypassOverlay,
    });
  } catch {
    return fallbackCapturedViewModel(cdp, tabId);
  }
}

/** Pure VOM capture pipeline shared by snapshot, observe, and recording. */
export async function captureVomObservation(
  cdp: CdpRunner,
  tabId: number,
  url: string | undefined,
  opts: CaptureVomObservationOptions = {},
): Promise<CaptureVomObservationResult> {
  await cdp.ensureAttachedToUrl?.(tabId, url);
  await cdp.send<unknown>(tabId, "Accessibility.enable", {});
  const result = await cdp.send<{ nodes: CdpAxNode[] }>(tabId, "Accessibility.getFullAXTree", {});
  const axNodes = result.nodes ?? [];
  const captured = await captureForVom(
    cdp,
    tabId,
    opts.conditionalSurfaceProbe ?? false,
    opts.hoverProbeBypassOverlay,
  );
  const scene = buildVomScene(axNodes, captured, { pageUrl: url });
  const rendered = renderVom(scene, {
    maxDepth: opts.maxDepth,
    maxTokens: opts.maxTokens,
    redactValues: opts.redactValues,
    activeRegionPolicy: opts.activeRegionPolicy ?? true,
  });
  return {
    text: rendered.text,
    refs: rendered.refs,
    truncated: rendered.truncated,
    captured: captured.nodes,
    surfaceProbes: captured.surfaceProbes,
  };
}
