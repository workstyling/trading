// Firebase configuration
const firebaseConfig = {
    apiKey: "AIzaSyDIIltVePgW4gnh63hJjH3To5HompaHYiU",
    authDomain: "tradingcryptodata.firebaseapp.com",
    databaseURL: "https://tradingcryptodata-default-rtdb.firebaseio.com/",
    projectId: "tradingcryptodata",
    storageBucket: "tradingcryptodata.appspot.com",
    messagingSenderId: "714924244385",
    appId: "1:714924244385:web:1f4f2f51d85c59d9f3dfe0"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const database = firebase.database();