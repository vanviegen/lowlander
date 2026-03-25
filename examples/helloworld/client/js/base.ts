import 'mdui/mdui.css';
import 'mdui/components/button.js';
import 'mdui/components/fab.js';
import 'mdui/components/text-field.js';
import { alert } from 'mdui/functions/alert.js';
import type * as API from '../../server/api.js';
import { Connection } from 'lowlander/client';
import A from 'aberdeen';

import { setColorScheme } from 'mdui/functions/setColorScheme.js';
// Generate a color scheme based on #0061a4 and set the <html> element to that color scheme
setColorScheme('#ef6b00');

A.setSpacingCssVars();

const WEBSOCKET_URL = `ws://${location.hostname}:8080/`;

// Create a WebSocket connection with type-safe RPC to the server API.
const connection = new Connection<typeof API>(WEBSOCKET_URL);
const api = connection.api;
A('h2#Online')
// Create a reactive scope to render online status
A(() => {
    A(connection.isOnline() ? 'text=yes' : 'text=no');
});

// Simple RPC call - returns a PromiseProxy that resolves to the result.
const sum = api.add(1234, 6753);
A('h2#Answer')
A.dump(sum);

// Server proxy example - authenticate returns both a value and a stateful API object.
const auth = api.authenticate('Frank');
A('h2#AuthToken');
A.dump(auth); // auth.value will become "secret" once authentication completes


// Access the server-side UserAPI through the .serverProxy property.
// Note that this proxy is usable immediately, even though the authentication
// call is still in progress - the server will process requests in-order.
// If authentication were to fail, so would any calls on the server proxy.
const userApi = auth.serverProxy;

// Call methods on the server proxy (returns PromiseProxy like regular RPC).
const bio = userApi.getBio();
A('h2#Bio');
A.dump(bio); // bio.value will become "1:Frank"

// Model streaming - returns a reactive proxy that updates when server-side model changes.
const model = api.streamModel();
A('h2#Model');
A.dump(model); // Live model (and nested linked models) will appear in model.value

A('h2#Toggle friend');
const formBusy = A.proxy(false);
const friendName = A.proxy('');
A('form display:flex gap:$2', 'submit=', async (e: any) => {
    e.preventDefault();
    formBusy.value = true;
    const found = await userApi.toggleFriend(friendName.value).promise;
    formBusy.value = false;
    if (!found) alert({description: 'No such person: ' + friendName.value});
}, () => {
    A('mdui-text-field label="Person name" bind=', friendName);
    A(() => {
        if (formBusy.value) A('mdui-circular-progress');
        else A('mdui-button type=submit #Toggle friend');
    })
});



// Socket streaming - server pushes data via callbacks.
const data = A.proxy([] as number[]);
let dataIndex = 0;
api.streamSomething(item => data[dataIndex++ % 20] = item);
A('h2#Streamed data');
A.dump(data);

A('mdui-fab icon=admin_panel_settings text="Lowlander Admin" click=', async () => {
    const { showAdminModal } = await import('./admin');
    showAdminModal(api);
});
