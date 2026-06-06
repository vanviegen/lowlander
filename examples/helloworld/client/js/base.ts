import A from 'aberdeen';
import S from 'staffa';
import type * as API from '../../server/api.js';
import { Connection } from 'lowlander/client';

const WEBSOCKET_URL = `ws://${location.hostname}:8080/`;

const connection = new Connection<typeof API>(WEBSOCKET_URL);
const api = connection.api;

const sum = api.add(1234, 6753);
const auth = api.authenticate('Frank');
const userApi = auth.serverProxy;
const bio = userApi.getBio();
const model = api.streamModel();

const formBusy = A.proxy(false);
const friendName = A.proxy('');
const data = A.proxy([] as number[]);
let dataIndex = 0;
api.streamSomething((item: number) => (data as any)[dataIndex++ % 20] = item);

A.mount(document.body, () => {
    S.main({
        title: 'Lowlander Hello World',
        maxWidth: '48rem',
        content: () => {
            S.box({ header: 'Connection', content: () => {
                A('p', 'm:0', () => {
                    A('#Online: ');
                    A(() => A(connection.isOnline() ? 'text=yes' : 'text=no'));
                });
            }});

            S.box({ header: 'Add(1234, 6753)', content: () => A.dump(sum) });

            S.box({ header: 'Auth token', content: () => A.dump(auth) });

            S.box({ header: 'Bio', content: () => A.dump(bio) });

            S.box({ header: 'Live model', content: () => A.dump(model) });

            S.box({ header: 'Toggle friend', content: () => {
                S.form({
                    submit: async () => {
                        formBusy.value = true;
                        const found = await userApi.toggleFriend(friendName.value).promise;
                        formBusy.value = false;
                        if (!found) S.alert('No such person: ' + friendName.value);
                    },
                    content: () => S.textline({ label: 'Person name', bind: friendName }),
                    actions: () => {
                        A(() => {
                            if (formBusy.value) A('span', 'fg:$sFgMuted', '#Busy…');
                            else S.button({ text: 'Toggle friend', type: 'submit' });
                        });
                    },
                });
            }});

            S.box({ header: 'Streamed data', content: () => A.dump(data) });
        },
    });
});
