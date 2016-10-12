import { VNode, makeDOMDriver } from "@cycle/dom";
import { DOMSource } from "@cycle/dom/rx-typings";
import Cycle from "@cycle/rx-run";
import * as Immutable from "immutable";
import * as Rx from "rx";
import Collector from "./rxfiddle-collector";
import RxMarbles from "rxmarbles";

const Observable = Rx.Observable;
let collector = new Collector();
collector.setup();
collector.logger.attach(document.getElementById("graph"));

// Setup
RxMarbles.AddCollectionOperator(undefined);
RxMarbles.AddCollectionOperator(Rx);

interface ISources {
  DOM: DOMSource;
}

interface ISinks {
  DOM: Rx.Observable<VNode>;
}

function log(text: string) {
  let div = document.createElement("div");
  div.innerText = text;
  document.getElementById("log").appendChild(div);
}

function main(sources: ISources): ISinks {
  let data = Immutable.fromJS({
    end: 100,
    notifications: [{
      content: "A",
      diagramId: 0,
      id: 1,
      time: 10,
    }],
  });
  const diagram = RxMarbles.DiagramComponent({ DOM: sources.DOM, props: {
    class: "diagram",
    data: Observable.of(data, data, data),
    interactive: Observable.of(true, true, true, true),
    key: `diagram0`,
  }});

  diagram.DOM.map(id => id).subscribe(a => log(a + ""));
  return {
    DOM: diagram.DOM,
  };
}

Cycle.run(main, {
  DOM: makeDOMDriver("#app"),
});
