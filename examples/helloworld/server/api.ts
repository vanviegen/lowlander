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
        const result = Person.byName.get(this.userName);
        if (!result) throw new Error(`User '${this.userName}' not found`);
        return result;
    }

    getBio() {
        return `${this.user.name} is ${this.user.age} years old and has ${this.user.friends.length} friend(s).`;
    }

    toggleFriend(friendName: string) {
        console.log('toggleFriends', this.user.friends, 'looking for', friendName);
        for(const [idx, val] of Object.entries(this.user.friends)) {
            if (val.name === friendName) {
                this.user.friends.splice(Number(idx), 1);
                console.log('removed', this.user.friends);
                return true;
            }
        }
        const friend = Person.byName.get(friendName);
        if (!friend) return false;
        this.user.friends.push(friend);
        console.log('added', this.user.friends);
        return true;
    }

    // admin() {
    //     if (this.user.name !== 'Frank') {
    //         throw new Error('Access denied');
    //     }
    //     return new ServerProxy(admin);
    // }
}

// Authentication example - returns a ServerProxy with both a value and API object
export async function authenticate(auth: string) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const user = Person.byName.get(auth);
    if (!user) throw new Error('User not found');
    // Client receives 'secret' as .value and UserAPI methods via .serverProxy
    return new ServerProxy(new UserAPI(auth), 'secret');
}


// Edinburgh model definitions
@E.registerModel
class Person extends E.Model<Person> {
    static byName = E.primary(Person, 'name');
    name = E.field(E.string);
    age = E.field(E.number);
    friends = E.field(E.array(E.link(Person)));
    password = E.field(E.string);
}

@E.registerModel
class MyModel extends E.Model<MyModel> {
    id = E.field(E.identifier);
    name = E.field(E.string);
    next = E.field(E.opt(E.link(MyModel)));
    owner = E.field(E.link(Person));
    createdAt = E.field(E.dateTime);

    static byId = E.primary(MyModel, 'id');
    static byName = E.unique(MyModel, 'name');
}

let ids: {p1: string, p2: string, m1: string, m2: string};
export async function resetTestData(deleteEverything: boolean) {
    if (deleteEverything) {
        console.log('delete');
        await E.deleteEverything();
        console.log('deleted');
    }

    // Initialize some test data. Even if we are already running in a transaction, we need to do this
    // in a new (nested) transaction, as deleteEverything will have done *its* work in separate transactions
    // as well, and we need access to its results.
    await E.transact(() => {
        console.log('Frank', Person.byName.get('Frank'));
        let p1 = Person.byName.get('Frank') || new Person({name: 'Frank', age: 45, password: 'secret'});
        let p2 = Person.byName.get('Alice') || new Person({name: 'Alice', age: 25, password: 'hidden', friends: [p1]});
        let p3 = Person.byName.get('Bob') || new Person({name: 'Bob', age: 65, password: 'himom', friends: [p1, p2]});
        if (p1.getState() === "created") p1.friends = [p2, p3];
        let m1 = MyModel.byName.get('Test') || new MyModel({name: 'Test', owner: p1});
        let m2 = MyModel.byName.get('Another') || new MyModel({name: 'Another', owner: p2, next: m1});
        ids = {p1: p1.name, p2: p2.name, m1: m1.id, m2: m2.id};
    });
    return ids;
}
resetTestData(false);

await E.transact(() => {
    E.dump();
    for(const p of Person.findAll()) {
        console.log('Person:', p.name, 'age', p.age, 'friends', p.friends.map(f => f.name).join(','), 'password', p.password);
    }
});


// Create a stream type that specifies which fields to send to clients
// Note: password is excluded for security, and we include nested linked model fields
const MyStream = createStreamType(MyModel, {
    name: true,
    createdAt: true,
    owner: {
        name: true,
        age: true,
        friends: {
            name: true,
            age: true,
        }
    }
});

// Example of model streaming - returns a reactive proxy that auto-updates on changes
export function streamModel() {
    const m1 = MyModel.byId.get(ids.m1)!;
    return new MyStream(m1);
}

export async function incrOwnerAge(delta: number) {
    const m1 = MyModel.byId.get(ids.m1)!;
    const current = m1.owner.age;
    await new Promise(resolve => setTimeout(resolve, 50));
    m1.owner.age = current + delta;
}

export function setOwnerAge(age: number) {
    const m1 = MyModel.byId.get(ids.m1)!;
    m1.owner.age = age;
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

