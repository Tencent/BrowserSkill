import { i18n } from "@browser-skill/i18n";

// happy-dom 15.x passes an unreferenced closure to `new WeakRef((record) => this.report(record))`
// inside `MutationObserverListener`, allowing V8 scavenges across async turns to collect active
// observer callbacks before `disconnect()`. Patch the shared `MutationObserverImplementation`
// prototype once per V8 isolate so both top-level and subframe `Window` subclasses pin active
// callbacks while `WeakMap` ephemeron GC still reclaims them upon `disconnect()`.
if (typeof MutationObserver === "function") {
  const patchedMark = Symbol.for("bsk.happyDomMutationObserverPinned");
  const baseProto = Object.getPrototypeOf(MutationObserver.prototype) as {
    observe?: typeof MutationObserver.prototype.observe;
    [key: symbol]: unknown;
  } | null;
  const targetProto = (
    typeof baseProto?.observe === "function" ? baseProto : MutationObserver.prototype
  ) as { observe: typeof MutationObserver.prototype.observe; [key: symbol]: unknown };
  if (!targetProto[patchedMark]) {
    targetProto[patchedMark] = true;
    const pinnedCallbacks = new WeakMap<object, unknown>();
    let mutationListenersSymbol: symbol | undefined;
    const originalObserve = targetProto.observe;
    targetProto.observe = function (target: Node, options?: MutationObserverInit) {
      originalObserve.call(this, target, options);
      mutationListenersSymbol ??= Object.getOwnPropertySymbols(target).find(
        (sym) => sym.description === "mutationListeners",
      );
      const listeners = mutationListenersSymbol
        ? (target as unknown as Record<symbol, unknown>)[mutationListenersSymbol]
        : undefined;
      if (!Array.isArray(listeners)) return;
      for (const listener of listeners) {
        if (listener && typeof listener === "object" && !pinnedCallbacks.has(listener)) {
          const callback = (listener as { callback?: WeakRef<object> }).callback?.deref?.();
          if (callback) pinnedCallbacks.set(listener, callback);
        }
      }
    };
  }
}

await i18n.changeLanguage("zh-CN");
