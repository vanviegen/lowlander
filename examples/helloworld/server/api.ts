import * as E from "edinburgh";
import { ServerProxy, createStreamType, Socket } from "lowlander/server";
import * as warpsocket from "warpsocket";

export const getDebugState = warpsocket.getDebugState;

// Simple RPC function example
export function add(a: number, b: number): number {
    return a + b;
}

// Example of a stateful server-side API that's exposed via ServerProxy
export class UserAPI {
    constructor(public userName: string) {}

    get user(): Person {
        const result = Person.get(this.userName);
        if (!result) throw new Error(`User '${this.userName}' not found`);
        return result;
    }

    getBio() {
        return `${this.user.name} is ${this.user.age} years old and has ${this.user.friends.length} friend(s).`;
    }

    toggleFriend(friendName: string) {
        for(const [idx, val] of Object.entries(this.user.friends)) {
            if (val.name === friendName) {
                this.user.friends.splice(Number(idx), 1);
                return true;
            }
        }
        const friend = Person.get(friendName);
        if (!friend) return false;
        this.user.friends.push(friend);
        return true;
    }

    onDrop() {
        this.user.onlineCount--;
    }
}

// Authentication example - returns a ServerProxy with both a value and API object
export async function authenticate(auth: string) {
    const user = Person.get(auth);
    if (!user) throw new Error('User not found');
    user.onlineCount++;
    // Client receives 'secret' as .value and UserAPI methods via .serverProxy
    return new ServerProxy(new UserAPI(auth), 'secret');
}

export function getOnlineUsers() {
    return [...Person.findBy('online')].map(p => p.name);
}

export function greet(name: string, greeting: string = 'Hello') {
    return `${greeting}, ${name}!`;
}


// Edinburgh model definitions
const Person = E.defineModel('Person', class {
    name = E.field(E.string);
    age = E.field(E.number);
    friends = E.field(E.array(E.link(() => Person)));
    password = E.field(E.string);
    onlineCount = E.field(E.number);
}, {
    pk: 'name',
    index: { online: (p: any) => p.onlineCount > 0 ? [true] : [] },
});
type Person = InstanceType<typeof Person>;

const MyModel = E.defineModel('MyModel', class {
    id = E.field(E.identifier);
    name = E.field(E.string);
    next = E.field(E.opt(E.link(() => MyModel)));
    owner = E.field(E.link(Person));
    createdAt = E.field(E.dateTime);
    meta = E.field(E.record(E.number));
}, {
    pk: 'id',
    unique: { name: 'name' },
});

let ids: {p1: string, p2: string, m1: string, m2: string};
export async function resetTestData(deleteEverything: boolean) {
    if (deleteEverything) {
        await E.deleteEverything();
    }

    // Initialize some test data. Even if we are already running in a transaction, we need to do this
    // in a new (nested) transaction, as deleteEverything will have done *its* work in separate transactions
    // as well, and we need access to its results.
    await E.transact(() => {
        let p1 = Person.get('Frank') || new Person({name: 'Frank', age: 45, password: 'secret'});
        let p2 = Person.get('Alice') || new Person({name: 'Alice', age: 25, password: 'hidden', friends: [p1]});
        let p3 = Person.get('Bob') || new Person({name: 'Bob', age: 65, password: 'himom', friends: [p1, p2]});
        if (p1.getState() === "created") p1.friends = [p2, p3];
        // Reset onlineCount on startup (no clients connected yet)
        for (const p of [p1, p2, p3]) p.onlineCount = 0;
        let m1 = MyModel.getBy('name', 'Test') || new MyModel({name: 'Test', owner: p1, meta: {score: 42, level: 7}});
        let m2 = MyModel.getBy('name', 'Another') || new MyModel({name: 'Another', owner: p2, next: m1, meta: {}});
        ids = {p1: p1.name, p2: p2.name, m1: m1.id, m2: m2.id};
    });
}
resetTestData(false);
``
await E.transact(() => {
    E.dump();
    for(const p of Person.find()) {
        console.log('Person:', p.name, 'age', p.age, 'friends', p.friends.map(f => f.name).join(','), 'password', p.password);
    }
});


// Create a stream type that specifies which fields to send to clients
// Note: password is excluded for security, and we include nested linked model fields
const MyStream = createStreamType(MyModel, {
    name: true,
    createdAt: true,
    meta: true,
    owner: {
        name: true,
        age: true,
        friends: {
            name: true,
            age: true,
        }
    }
});

const CachedStream = createStreamType(MyModel, {
    name: true,
    owner: { name: true },
}, { cache: 60 });

// Example of model streaming - returns a reactive proxy that auto-updates on changes
export function streamModel() {
    const m1 = MyModel.get(ids.m1)!;
    return new MyStream(m1);
}

export function streamModelCached() {
    const m1 = MyModel.get(ids.m1)!;
    return new CachedStream(m1);
}

export async function incrOwnerAge(delta: number) {
    const m1 = MyModel.get(ids.m1)!;
    const current = m1.owner.age;
    await new Promise(resolve => setTimeout(resolve, 50));
    m1.owner.age = current + delta;
}

export function setOwnerAge(age: number) {
    const m1 = MyModel.get(ids.m1)!;
    m1.owner.age = age;
}

export function setModelName(name: string) {
    const m1 = MyModel.get(ids.m1)!;
    m1.name = name;
}

export function setMeta(key: string, value: number) {
    const m1 = MyModel.get(ids.m1)!;
    m1.meta = {...m1.meta, [key]: value};
}

export function deleteMeta(key: string) {
    const m1 = MyModel.get(ids.m1)!;
    const copy = {...m1.meta};
    delete copy[key];
    m1.meta = copy;
}


// Example of server-push streaming via Socket callback
// Client provides a callback; server pushes data by calling socket.send()
export function streamSomething(socket: Socket<number>) {
    let interval = setInterval(() => {
        console.log('Sending ping');
        // socket.send() returns false when client disconnects
        if (!socket.send(Math.random())) {
            console.log('Socket is not open');
            clearInterval(interval);
        }
    }, 2000);
}

