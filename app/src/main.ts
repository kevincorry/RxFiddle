import AnalyticsObserver from "./analytics"
import JsonCollector from "./collector/jsonCollector"
import LocalStorageCollector, { LocalStorageSender } from "./collector/postMessageCollector"
import RxRunner from "./collector/runner"
import patch from "./patch"
import "./prelude"
import CodeEditor from "./ui/codeEditor"
import { hbox, vbox, vboxo } from "./ui/flex"
import Resizer from "./ui/resizer"
import { LanguageMenu, Query, errorHandlerOperator, shareButton } from "./ui/shared"
import { SnippetBrowser } from "./ui/snippetBrowser"
import Splash from "./ui/splash"
import { UUID } from "./utils"
import Visualizer, { DataSource } from "./visualization"
import Grapher from "./visualization/grapher"
import * as Rx from "rxjs"
import h from "snabbdom/h"
import { VNode } from "snabbdom/vnode"

// Inception
import Logger from "./collector/logger"
import { TreeCollector } from "./instrumentation/rxjs-5.x.x/collector"
import Instrumentation from "./instrumentation/rxjs-5.x.x/instrumentation"

// Inception
if (Query.get("instrument")) {
  let sender = new LocalStorageSender(UUID())
  let instrumentation = new Instrumentation(new TreeCollector(new Logger(m => sender.send(m))))
  instrumentation.setup()
}

const DataSource$: Rx.Observable<{
  data: DataSource,
  vnode?: Rx.Observable<VNode>,
  runner?: RxRunner,
  editor?: CodeEditor,
  q: any
}> = Query.$all.scan((prev, q) => {
  if (q.type === "message") {
    let collector = prev.type === "message" && prev.q.session === q.session ?
      prev.collector :
      new LocalStorageCollector(q.session)
    // doRender = false
    return { data: collector, q }
  } else if (q.type === "demo" && q.source) {
    let collector = prev.type === "demo" ? prev.collector : new JsonCollector()
    if (!prev.q || q.source !== prev.q.source) { collector.restart(q.source) }
    return { data: collector, q }
  } else if (q.type === "ws" && q.url) {
    let collector = prev.type === "ws" ? prev.collector : new JsonCollector()
    if (!prev.q || q.url !== prev.q.url) { collector.restart(q.url) }
    return { data: collector, q }
  } else if (q.type === "editor") {
    if (q.type === prev.q.type && q.lib === prev.q.lib) {
      let editor = prev.editor
      let runner = prev.runner
      return {
        data: runner,
        runner,
        editor,
        vnode: editor.dom,
        q,
      }
    } else {
      let config = LanguageMenu.get(q.lib).runnerConfig
      let editor = new CodeEditor(q.session || undefined,
        q.code ? atob(decodeURI(q.code)) : undefined,
        undefined, undefined, false)
      let runner = new RxRunner(config, editor.code, AnalyticsObserver)
      return {
        data: runner,
        runner,
        editor,
        vnode: editor.dom,
        q,
      }
    }
  } else {
    return { q }
  }
}, { q: {} }).distinctUntilChanged((a, b) => b.data ? b.data === a.data : JSON.stringify(a.q) === JSON.stringify(b.q))

Query.$.map(query => ({ query, type: "query" })).subscribe(AnalyticsObserver)

function menu(language: VNode, runner?: RxRunner, editor?: CodeEditor): VNode {
  let clickHandler = () => {
    editor.code.take(1).subscribe(v => {
      Query.update({ code: btoa(v) })
      runner.trigger()
    })
  }
  return h("div.left.flex", { attrs: { id: "menu" } }, [
    language,
    ...(runner ? [
      h(`button.btn${runner.currentState === "initializing" ? ".disabled" : ""}`, {
        attrs: { disabled: runner.currentState === "initializing" ? true : false },
        on: { click: clickHandler },
      }, runner.action),
    ] : []),
    ...(editor ? [shareButton(editor)] : []),
  ])
}

const VNodes$: Rx.Observable<VNode[]> = DataSource$.switchMap(collector => {
  if (collector && collector.data) {

    // Attach language menu
    const LanguageMenu$ = new LanguageMenu().stream()
    let langObs = LanguageMenu$.language
      .skip(1)
      .do(lang => Query.update({ lib: lang.id }))

    // Attach run button
    let runObs = collector.editor.externalState.do(() => collector.runner.trigger())
    let stateObs = collector.runner.state.do(
      d => collector.editor.setState(d === "used" ? { type: "running" } : { type: "stopped" }),
      (e: ErrorEvent) => collector.editor.setState({
        error: e.error, position: { ch: e.colno, line: e.lineno }, type: "error",
      })
    )

    return Rx.Observable.of(0)
      .merge(langObs.ignoreElements())
      .merge(runObs.ignoreElements())
      .merge(stateObs.ignoreElements())
      .flatMap(_ => {
        let vis = new Visualizer(new Grapher(collector.data))
        return vis.stream(AnalyticsObserver)
      })
      .let(errorHandlerOperator)
      .startWith({ dom: h("span.rxfiddle-waiting", "Waiting for Rx activity..."), timeSlider: h("div") })
      .combineLatest(
      collector.vnode || Rx.Observable.of(undefined),
      LanguageMenu$.dom,
      collector.runner && collector.runner.state || Rx.Observable.of(undefined),
      (render, input, langs, state) => [
        h("div#menufold-static.menufold", [
          h("a.brand.left", { attrs: { href: "#" } }, [
            h("img", { attrs: { alt: "ReactiveX", src: "images/RxIconXs.png" } }),
            "RxFiddle" as any as VNode,
          ]),
          menu(langs, collector.runner, collector.editor),
        ]),
        // h("div#menufold-fixed.menufold"),
        hbox(...(input ?
          [Resizer.h(
            "rxfiddle/editor+rxfiddle/inspector",
            input as any,
            vboxo({ class: "viewer-panel" }, /*render.timeSlider,*/ render.dom)
          )] :
          [vbox(/*render.timeSlider,*/ render.dom)]
        )),
      ])
  } else if (collector.q.type === "samples") {
    return SnippetBrowser()
  } else {
    return new Splash().stream().map(n => [n])
  }
})

let app = document.querySelector("body") as VNode | HTMLBodyElement
VNodes$.subscribe(vnodes => {
  try {
    app = patch(app, h("body#", { tabIndexRoot: true }, vnodes))
  } catch (e) {
    console.error("Error in snabbdom patching; restoring. Next patch will be handled clean.", e)
    app = document.querySelector("body")
  }
})
