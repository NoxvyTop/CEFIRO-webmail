const raw = crypto.getRandomValues(new Uint8Array(32));
console.log(btoa(String.fromCharCode(...raw)));
