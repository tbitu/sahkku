import { executeSearchRequest, type SearchRequest, type SearchResponse } from "./worker-protocol";

globalThis.onmessage = (event: MessageEvent<SearchRequest>) => {
  const send = (message: SearchResponse): void => globalThis.postMessage(message);
  void executeSearchRequest(event.data).then(
    result => send({ ok: true, result }),
    error => send({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
};
