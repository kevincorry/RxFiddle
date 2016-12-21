import "../utils"
import { ICallRecord } from "./callrecord"
import { RxFiddleEdge } from "./edge"
import { IEvent } from "./event"
import { lines, rankLongestPath, structureLayout, indexedBy, Ranked } from "./graphutils"
import { AddEvent, AddObservable, AddStackFrame, AddSubscription, ICollector, instanceAddSubscription } from "./logger"
import { RxFiddleNode } from "./node"
import { Edge as GraphEdge, Graph, alg } from "graphlib"
import TypedGraph from "./typedgraph"
import * as snabbdom from "snabbdom"
import { VNode } from "snabbdom"
import * as _ from "lodash"
import "../utils"
import { StackFrame } from "../utils"
import "../object/extensions"
import { Grapher, Leveled, ShadowEdge, LayerCrossingEdge } from "./grapher"

/* tslint:disable:no-var-requires */
const dagre = require("dagre")
const svgPanZoom = typeof window !== "undefined" ? require("svg-pan-zoom") : {}
const h = require("snabbdom/h")
const patch = snabbdom.init([
  require("snabbdom/modules/attributes"),
  require("snabbdom/modules/eventlisteners"),
])
// const ErrorStackParser = require("error-stack-parser")
/* tslint:enable:no-var-requires */

/**
 * HSV values from [0..1[
 * RGB values from 0 to 255
 * @see http://martin.ankerl.com/2009/12/09/how-to-create-random-colors-programmatically/
 */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  let h_i = ~~(h*6)
  let f = h * 6 - h_i
  let p = v * (1 - s)
  let q = v * (1 - f * s)
  let t = v * (1 - (1 - f) * s)
  var r = 0, g = 0, b = 0
  switch (h_i) {
    case 0: [r, g, b] = [v, t, p]; break;
    case 1: [r, g, b] = [q, v, p]; break;
    case 2: [r, g, b] = [p, v, t]; break;
    case 3: [r, g, b] = [p, q, v]; break;
    case 4: [r, g, b] = [t, p, v]; break;
    case 5: [r, g, b] = [v, p, q]; break;
  }
  return [~~(r * 265), ~~(g * 265), ~~(b * 265)]
}

const golden_ratio_conjugate = 0.618033988749895
function generateColors(count: number): [number,number,number][] {
  let cs = <[number,number,number][]>[]
  let h = Math.random()  // use random start value

  while(count--) {
    h += golden_ratio_conjugate
    h %= 1
    cs.push(hsvToRgb(h, 0.5, 0.95))
  }
  return cs
}

const colors = generateColors(40) // ["#0066B9", "#E90013", "#8E4397", "#3FB132", "#FDAC00", "#F3681B", "#9FACB3", "#9CA2D4", "#E84CA2"]
function colorIndex(i: number) {
  if(typeof i === "undefined") return "transparent"
  let [r,g,b] = colors[i % colors.length]
  return `rgb(${r},${g},${b})`
}
(<any>window).colors = colors;

function toDot<T>(graph: Graph, props?: (n: T) => any): string {
  return "graph g {\n" +
    "node [style=filled];\n" +
    graph.nodes().map((n: any) => {
      if(props) {
        let data = props(n)
        let query = Object.keys(data).map(k => `${k}="${data[k]}"`).join(", ")
        return `"${n}" [${query}];`
      }
      return `"${n}";`
    }).join("\n") +
    graph.edges().map((e: GraphEdge) =>
      e.v + " -- " + e.w + " [type=s];"
    ).join("\n") +
    "\n}"
}

const defs: () => VNode[] = () => [h("defs", [
  h("marker", {
    attrs: {
      id: "arrow",
      markerHeight: 10,
      markerUnits: "strokeWidth",
      markerWidth: 10,
      orient: "auto",
      overflow: "visible",
      refx: 0, refy: 3,
    },
  }, [h("path", { attrs: { d: "M-4,-2 L-4,2 L0,0 z", fill: "inherit" } })]),
  h("marker", {
    attrs: {
      id: "arrow-reverse",
      markerHeight: 10,
      markerUnits: "strokeWidth",
      markerWidth: 10,
      orient: "auto",
      overflow: "visible",
      refx: 0, refy: 3,
    },
  }, [h("path", { attrs: { d: "M0,0 L4,2 L4,-2 z", fill: "blue" } })]),
])]

export interface RxCollector {
  wrapHigherOrder<T>(subject: Rx.Observable<any>, fn: Function): (arg: T) => T
  before(record: ICallRecord, parents?: ICallRecord[]): this
  after(record: ICallRecord): void
}

export class Visualizer {
  public metroLines: { [sink: number]: number[] } = {}
  public svgZoomInstance: { destroy(): void } | null = null

  private showIdsBacking = false
  public get showIds() {
    return this.showIdsBacking
  }
  public set showIds(value: boolean) {
    this.showIdsBacking = value
    this.run()
  }

  private componentId = 0
  public get component() {
    return this.componentId
  }
  public set component(value: number) {
    this.componentId = value
    this.choices = []
    this.run()
  }

  private choices: string[] = []

  private app: HTMLElement | VNode
  private controls: HTMLElement | VNode
  private rendered: number = 0
  private collector: ICollector

  private grapher: Grapher

  constructor(collector: ICollector, dom?: HTMLElement, controls?: HTMLElement) {
    this.app = dom
    this.controls = controls
    this.collector = collector
    this.grapher = new Grapher(collector)
    this.grapher.g.setGraph({})

    if (!!window) {
      (<any>window).alg = alg;
      (<any>window).dagre = dagre;
      (<any>window).combined = this.grapher.combined;
      (<any>window).toDot = toDot;
      (<any>window).rankLongestPath = rankLongestPath
    }
  }

  public structureDag(): Graph {
    return this.grapher.structureDag()
  }

  public layout(graph: TypedGraph<RxFiddleNode,RxFiddleEdge> = this.grapher.g) {
    graph.setGraph({})
    this.grapher.nodes.forEach(n => n.layout())
    dagre.layout(graph)
  }

  public size(graph: TypedGraph<RxFiddleNode,RxFiddleEdge> = this.grapher.g): { w: number, h: number } {
    if (this.grapher.nodes.length === 0) {
      return { h: 10, w: 10 }
    }
    this.layout(graph)
    let g = graph.graph()
    return { h: g.height, w: g.width }
  }

  public highlightSubscriptionSource(id?: number, level: number = 1) {
    let sub = this.collector.getSubscription(id)
    if (typeof sub !== "undefined") {
      if (level < 0.1) { return }
      sub.sinks.forEach(p => {
        this.highlightSubscriptionSource(p, level * 0.9)
        let parent = this.collector.getSubscription(p)
        let node = this.grapher.nodes[parent.observableId]
        if (node) { node.setHighlightId(patch, parent.id) }
      })
    } else {
      this.grapher.nodes.forEach(n => { n.setHighlightId(patch) })
    }
  }

  public render(graph: TypedGraph<RxFiddleNode,RxFiddleEdge>): VNode {
    this.rendered = this.collector.length

    if (typeof graph === "undefined" || graph.nodes().length === 0) {
      return h("g")
    }

    this.layout(graph)

    let ns = graph.nodes().map((id: string) => this.grapher.node(id).render(patch, this.showIds))
      .reduce((p, c) => p.concat(c), [])
    let es = graph.edges().map((e) => {
      let edge = this.grapher.edge(e)
      return edge.render()
    })
    let childs = es.concat(ns)

    return h("g", { attrs: { class: "visualizer" } }, childs)
  }

  public selection(graphs: Graph[]): VNode[] {
    return [h("select", {
      on: {
        change: (e: Event) => { console.log(e); this.component = parseInt((e.target as HTMLSelectElement).value, 10) },
      },
    }, graphs.map((g, i) => h("option", { attrs: { value: i } }, `graph ${i}`)))]
  }

  public run() {
    if (this.app instanceof HTMLElement) {
      this.app.innerHTML = ""
    }

    let changes = this.grapher.process()

    /* Prepare components */
    let comps = alg.components(this.grapher.dag as any)
    let graphs: TypedGraph<RxFiddleNode,RxFiddleEdge>[] = comps.map(array => this.grapher.dag.filterNodes(n => array.indexOf(n) >= 0))
    let graph = graphs[this.component]
    patch(this.controls, this.selection(graphs)[0]);

    (<any>window).graph = graph

    let render = this.render(graph)
    if (typeof graph !== "undefined") {
      this.size(graph)
    }

    let sg = new StructureGraph()
    
    let svg = sg.renderSvg(
      this.grapher.leveledGraph,
      this.choices,
      (v) => this.makeChoice(v, graph)
    )

    let app = h("app", [
      h("master", svg.concat(sg.renderMarbles(graph, this.choices))),
      h("detail", [
        h("svg", {
          attrs: {
            id: "svg",
            style: "width: 200px; height: 200px",
            version: "1.1",
            xmlns: "http://www.w3.org/2000/svg",
          },
        }, [render].concat(defs())),
      ]),
    ])

    patch(this.app, app)
    this.app = app

    if (this.svgZoomInstance && changes) {
      this.svgZoomInstance.destroy()
    }
    if (typeof graph !== "undefined" && (!this.svgZoomInstance || changes)) {
      console.log("svgZoomInstance")
      this.svgZoomInstance = svgPanZoom("#svg", { maxZoom: 30 })
    }

  }

  public makeChoice(v: string, graph: Graph) {
    let node = graph.node(v)
    console.log(v, graph, node)
    let newChoices = this.choices
    graph.predecessors(v).flatMap(p => this.descendants(graph, p)).forEach(n => {
      let index = newChoices.findIndex(c => c === n)
      if (index >= 0) {
        newChoices.splice(index, 1)
      }
    })
    newChoices.push(v)
    this.choices = newChoices
    this.run()
  }

  public descendants(graph: Graph, v: string): string[] {
    if (!alg.isAcyclic(graph)) {
      throw new Error("Only use this on acyclic graphs!")
    }
    let sc = graph.successors(v)
    return sc.concat(sc.flatMap(s => this.descendants(graph, s)))
  }

  public attach(node: HTMLElement) {
    this.app = node
    this.step()
  }

  public step() {
    window.requestAnimationFrame(() => this.step())
    if (this.rendered === this.collector.length) {
      return
    }
    this.run()
  }
}

class StructureGraph {

  public static traverse(graph: Graph, choices: string[] = []): string[] {
    if (typeof graph === "undefined") { return [] }

    let path: string[] = []
    let sources = graph.sources()
    do {
      // select first from choices or from successors otherwise
      let current = sources.find(source => choices.indexOf(source) >= 0) || sources[0]
      path.unshift(current)
      sources = graph.successors(current)
    } while (sources.length)

    return path.reverse()
  }

  public static branches(graph: Graph, node: string, choices: string[]): string[] {
    if (typeof graph === "undefined") { return [] }

    let successors = graph.successors(node)
    let chosen = successors.find(n => choices.indexOf(n) >= 0) || successors[0]
    return successors.filter(s => s !== chosen)
  }

  public static chunk: number = 100

  public renderMarbles(graph: Graph, choices: string[]): VNode[] {
    let coordinator = new MarbleCoordinator()
    let u = StructureGraph.chunk
    let main = StructureGraph.traverse(graph, choices)
    main.forEach((v) => coordinator.add(graph.node(v)))

    let root = h("div", {
      attrs: {
        id: "marbles",
        style: `width: ${u * 2}px; height: ${u * (0.5 + main.length)}px`,
      },
    }, main.flatMap((v, i) => {
      let clazz = "operator " + (typeof graph.node(v).locationText !== "undefined" ? "withStack" : "")
      let box = h("div", { attrs: { class: clazz } }, [
        h("div", [], graph.node(v).name),
        h("div", [], graph.node(v).locationText),
      ])
      return [box, coordinator.render(graph.node(v))]
    }))
    return [root]
  }

  public renderSvg(graph: TypedGraph<Leveled<StackFrame|AddObservable|AddSubscription>,LayerCrossingEdge|ShadowEdge|undefined>, choices: string[], cb: (choice: string) => void): VNode[] {
    let u = StructureGraph.chunk;
    (<any>window).renderSvgGraph = graph

    let g = graph
      .filterEdges(v => v.w < v.v)
      .filterNodes((_, n) => n.level === "subscription") as TypedGraph<Leveled<AddSubscription> & Ranked, ShadowEdge>
      // .filterEdges((_, e) => typeof e === "object" && "count" in e)
    
    let mapX = (x: number, y: number) => x // y > 14 ? x - 5 * (y - 14) : x

    let mu = u / 2

    // Let Observables determine ranking
    let ranks = rankLongestPath(graph.filterNodes((_, n) => n.level === "observable"))
    g.nodes().map(n => g.node(n).rank = ranks[g.node(n).payload.observableId])

    let structure = structureLayout(g)
    let structureIndex = indexedBy(i => i.node, structure.layout)
    let nodes = structure.layout/*.filter(item => !item.isDummy)*/.flatMap((item, i) => {
      return [h("circle", { 
        attrs: { 
          cx: mu + mu * mapX(item.x, item.y), 
          cy: mu + mu * item.y, 
          fill: colorIndex(item.hierarchicOrder[1]), 
          r: item.isDummy ? 2 : 5
        },
        on: {
          click: () => console.log(item),
        },
      }), h("text", { attrs: { x: mu + mu * mapX(item.x, item.y) + 10, y: mu + mu * item.y + 5 } }, item.isDummy ? "" : `${item.node}`)]
    })
    let edges = structure.edges.flatMap(({ v, w, points }) => {
      let path = points.map(({x,y}) => `${mu + mu * mapX(x, y)} ${mu + mu * y}`).join(" L ")
      return h("path", {
            attrs: {
              d: `M${path}`,
              stroke: "gray",
              "stroke-dasharray": 5,
              "stroke-width": g.edge(v, w) && g.edge(v, w).count * 4 || 4
            },
            on: { mouseover: () => console.log(graph.edge(v, w)) },
          })
    })

    let xmax = structure.layout.reduce((p, n) => Math.max(p, n.x), 0)

    return [h("svg", {
      attrs: {
        id: "structure",
        style: `width: ${xmax * u}px; height: ${u * (0.5 + structure.layout.length)}px`,
        version: "1.1",
        xmlns: "http://www.w3.org/2000/svg",
      },
    }, edges.concat(nodes))]
  }

}

class MarbleCoordinator {
  private min: number
  private max: number

  public add(node: RxFiddleNode): void {
    let times = node.observers.flatMap(v => v[2] as IEvent[]).map(e => e.time)
    this.min = times.reduce((m, n) => typeof m !== "undefined" ? Math.min(m, n) : n, this.min)
    this.max = times.reduce((m, n) => typeof m !== "undefined" ? Math.max(m, n) : n, this.max)
  }

  public render(node: RxFiddleNode): VNode {
    let events = node.observers.flatMap(v => v[2] as IEvent[])
    let marbles = events.map(e => h("svg", {
      attrs: { x: `${this.relTime(e.time)}%`, y: "50%" },
    }, [h("path", {
      attrs: { class: "arrow", d: "M 0 -50 L 0 48" },
    }), h("circle", {
      attrs: { class: e.type, cx: 0, cy: 0, r: 8 },
    })]))

    return h("svg", {
      attrs: {
        class: "marblediagram",
      },
    }, [
      h("line", { attrs: { class: "time", x1: "0", x2: "100%", y1: "50%", y2: "50%" } }),
    ].concat(marbles).concat(defs()))
  }

  private relTime(t: number): number {
    return (t - this.min) / (this.max - this.min) * 95 + 2.5
  }

}
