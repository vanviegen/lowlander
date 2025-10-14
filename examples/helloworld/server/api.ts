import * as E from "edinburgh";
import { ServerProxy, createStreamType, Socket } from "lowlander/server";

import * as admin from "lowlander/server/admin";


// Simple RPC function example
export function add(a: number, b: number): number {
    return a + b;
}


// Example of a stateful server-side API that's exposed via ServerProxy
export class UserAPI {
    constructor(public user: Person) {}

    getBio() {
        return `${this.user.name} is ${this.user.age} years old and has ${this.user.friends.length} friend(s).`;
    }

    toggleFriend(friendName: string) {
        for(const p of Person.findAll()) {
            console.log('-', p.name);
        }

        const friend = Person.byName.get(friendName);
        console.log(`toggleFriend ${this.user.name} toggling ${friendName} ->`, friend);
        if (!friend) return false;
        const index = this.user.friends.indexOf(friend);
        if (index >= 0) {
            this.user.friends.splice(index, 1);
        } else {
            this.user.friends.push(friend);
        }
        return true;
    }

    admin() {
        if (this.user.name === 'Frank') {
            return admin;
        }
    }
}

// Authentication example - returns a ServerProxy with both a value and API object
export async function authenticate(auth: string) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const user = Person.byName.get(auth);
    if (!user) throw new Error('User not found');
    // Client receives 'secret' as .value and UserAPI methods via .serverProxy
    return new ServerProxy(new UserAPI(user), 'secret');
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
// Initialize some test data
let ids = await E.transact(() => {
    let p1 = Person.byName.get('Frank') || new Person({name: 'Frank', age: 45, password: 'secret'});
    let p2 = Person.byName.get('Alice') || new Person({name: 'Alice', age: 25, password: 'hidden', friends: [p1]});
    let p3 = Person.byName.get('Bob') || new Person({name: 'Bob', age: 65, password: 'himom', friends: [p1, p2]});
    if (p1.getState() === "new") p1.friends = [p2, p3];
    let m1 = MyModel.byName.get('Test') || new MyModel({name: 'Test', owner: p1});
    let m2 = MyModel.byName.get('Another') || new MyModel({name: 'Another', owner: p2, next: m1});
    return {p1: p1.name, p2: p2.name, m1: m1.id, m2: m2.id};
});

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
            name: true
        }
    }
});

// Example of model streaming - returns a reactive proxy that auto-updates on changes
export function streamModel() {
    const m1 = MyModel.byId.get(ids.m1)!;
    return new MyStream(m1);
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
