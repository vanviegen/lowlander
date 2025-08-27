import type * as API from '../../server/api.js';
import { Connection } from 'lowlander/client';
import { $, dump, proxy } from "aberdeen";

const WEBSOCKET_URL = `ws://${location.hostname}:8080/`;

// Create a WebSocket connection with type-safe RPC to the server API.
const connection = new Connection<typeof API>(WEBSOCKET_URL);
const api = connection.api;
$('h2:Online')
// Create a reactive scope to render online status
$(() => {
    $(connection.isOnline() ? 'text=yes' : 'text=no');
});

// Simple RPC call - returns a PromiseProxy that resolves to the result.
const sum = api.add(1234, 6753);
$('h2:Answer')
dump(sum);

// Server proxy example - authenticate returns both a value and a stateful API object.
const auth = api.authenticate('Frank');
$('h2:Auth token');
dump(auth); // auth.value will become "secret" once authentication completes

// Access the server-side UserAPI through the .serverProxy property.
// Note that this proxy is usable immediately, even though the authentication
// call is still in progress - the server will process requests in-order.
// If authentication were to fail, so would any calls on the server proxy.
const userApi = auth.serverProxy;

// Call methods on the server proxy (returns PromiseProxy like regular RPC).
const bio = userApi.getBio();
$('h2:Bio');
dump(bio); // bio.value will become "1:Frank"

// Model streaming - returns a reactive proxy that updates when server-side model changes.
const model = api.streamModel();
$('h2:Model');
dump(model); // Live model (and nested linked models) will appear in model.value

$('h2:Toggle friend');
const formBusy = proxy(false);
const friendName = proxy('');
$('form submit=', async () => {
    formBusy.value = true;
    await userApi.toggleFriend(friendName.value).promise;
    formBusy.value = false;
}, () => {
    $('input placeholder="Friend name" bind=', friendName);
    $('button text="Toggle friend" .busy=', formBusy);
});

// Socket streaming - server pushes data via callbacks.
const data = proxy([] as number[]);
let dataIndex = 0;
api.streamSomething(item => data[dataIndex++ % 20] = item);
$('h2:Streamed data');
dump(data);
