const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const twilio = require("twilio");
const cron = require("node-cron");

const app = express();
const VoiceResponse = twilio.twiml.VoiceResponse;

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "prices.json");

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

function loadPrices() {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function savePrices(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function formatPrice(value) {
    const number = Number(value);
    if (Number.isNaN(number)) return "0.000";
    const parts = number.toFixed(3).split(".");
    return `${parts[0]} point ${parts[1]}`;
}

function safeKey(text) {
    return String(text)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
}

function getChangeText(contract) {
    const current = Number(contract.current);
    const open = Number(contract.open);
    const change = current - open;

    if (Math.abs(change) < 0.0005) {
        return "unchanged";
    }

    const direction = change > 0 ? "up" : "down";
    return `${direction} ${Math.abs(change).toFixed(3)}`;
}

function getStatusText(data, contract) {
    const changeText = getChangeText(contract);

    if (data.lastUpdateType === "close") {
        return `${contract.name} closed at ${formatPrice(contract.current)}, ${changeText}, on ${data.marketDate}.`;
    }

    if (data.lastUpdateType === "10am") {
        return `${contract.name} is currently ${formatPrice(contract.current)}, ${changeText}. This is the 10 AM update for ${data.marketDate}.`;
    }

    if (data.lastUpdateType === "2pm") {
        return `${contract.name} is currently ${formatPrice(contract.current)}, ${changeText}. This is the 2 PM update for ${data.marketDate}.`;
    }

    if (data.lastUpdateType === "open") {
        return `${contract.name} opened at ${formatPrice(contract.open)}, on ${data.marketDate}.`;
    }

    return `${contract.name} is currently ${formatPrice(contract.current)}, ${changeText}. Last updated ${data.marketDate}.`;
}

function getContractsByType(data, type) {
    return Object.entries(data.contracts)
        .filter(([key, contract]) => contract.type === type)
        .sort((a, b) => {
            const orderA = Number(a[1].menuOrder || 999);
            const orderB = Number(b[1].menuOrder || 999);
            return orderA - orderB;
        });
}

function sayAndGather(response, message, action) {
    const gather = response.gather({
        numDigits: 1,
        action,
        method: "POST",
        timeout: 5
    });

    gather.say(
        {
            voice: "Polly.Matthew",
            engine: "neural"
        },
        `<speak><prosody rate="85%">${message}</prosody></speak>`    );
}

function buildMenuMessage(title, contracts) {
    if (contracts.length === 0) {
        return `${title}. No futures are currently set up. Press 8 to go back.`;
    }

    let message = `${title}. `;

    contracts.forEach(([key, contract], index) => {
        const digit = index + 1;
        if (digit <= 7) {
            message += `Press ${digit} for ${contract.name}. <break time="500ms"/> `;
        }
    });

    message += "Press 8 to go back. <break time=\"400ms\"/> Press 9 to repeat.";
    return message;
}

function makeRoomForMenuOrder(data, type, newOrder) {
    const order = Number(newOrder);

    if (Number.isNaN(order) || order < 1) return;

    for (const key of Object.keys(data.contracts)) {
        const contract = data.contracts[key];

        if (contract.type === type && Number(contract.menuOrder) >= order) {
            contract.menuOrder = Number(contract.menuOrder) + 1;
        }
    }
}

function getContractByDigit(data, type, digit) {
    const contracts = getContractsByType(data, type);
    const index = Number(digit) - 1;

    if (Number.isNaN(index) || index < 0 || index >= contracts.length) {
        return null;
    }

    if (index > 6) {
        return null;
    }

    const [key, contract] = contracts[index];
    return { key, contract };
}

app.post("/voice", (req, res) => {
    const response = new VoiceResponse();

    sayAndGather(
        response,
        "Cattle futures line. Press 1 for Live Cattle. Press 2 for Feeder Cattle. Press 9 to repeat.",
        "/main-menu"
    );

    response.redirect({ method: "POST" }, "/voice");

    res.type("text/xml");
    res.send(response.toString());
});

app.post("/main-menu", (req, res) => {
    const digit = req.body.Digits;
    const response = new VoiceResponse();

    if (digit === "1") {
        response.redirect({ method: "POST" }, "/live-menu");
    } else if (digit === "2") {
        response.redirect({ method: "POST" }, "/feeder-menu");
    } else {
        response.redirect({ method: "POST" }, "/voice");
    }

    res.type("text/xml");
    res.send(response.toString());
});

app.post("/live-menu", (req, res) => {
    const data = loadPrices();
    const contracts = getContractsByType(data, "live");
    const response = new VoiceResponse();

    sayAndGather(
        response,
        buildMenuMessage("Live Cattle", contracts),
        "/live-choice"
    );

    response.redirect({ method: "POST" }, "/live-menu");

    res.type("text/xml");
    res.send(response.toString());
});

app.post("/live-choice", (req, res) => {
    const digit = req.body.Digits;
    const data = loadPrices();
    const response = new VoiceResponse();

    if (digit === "8") {
        response.redirect({ method: "POST" }, "/voice");
    } else if (digit === "9") {
        response.redirect({ method: "POST" }, "/live-menu");
    } else {
        const selected = getContractByDigit(data, "live", digit);

        if (selected) {
            response.say(
                {
                    voice: "Polly.Matthew",
                    engine: "neural"
                },
                `<speak><prosody rate="85%">${getStatusText(data, selected.contract)}</prosody></speak>`
            );            response.redirect({ method: "POST" }, "/live-menu");
        } else {
            response.redirect({ method: "POST" }, "/live-menu");
        }
    }

    res.type("text/xml");
    res.send(response.toString());
});

app.post("/feeder-menu", (req, res) => {
    const data = loadPrices();
    const contracts = getContractsByType(data, "feeder");
    const response = new VoiceResponse();

    sayAndGather(
        response,
        buildMenuMessage("Feeder Cattle", contracts),
        "/feeder-choice"
    );

    response.redirect({ method: "POST" }, "/feeder-menu");

    res.type("text/xml");
    res.send(response.toString());
});

app.post("/feeder-choice", (req, res) => {
    const digit = req.body.Digits;
    const data = loadPrices();
    const response = new VoiceResponse();

    if (digit === "8") {
        response.redirect({ method: "POST" }, "/voice");
    } else if (digit === "9") {
        response.redirect({ method: "POST" }, "/feeder-menu");
    } else {
        const selected = getContractByDigit(data, "feeder", digit);

        if (selected) {
            response.say(
                {
                    voice: "Polly.Matthew",
                    engine: "neural"
                },
                `<speak>${getStatusText(data, selected.contract)}</speak>`
            );            response.redirect({ method: "POST" }, "/feeder-menu");
        } else {
            response.redirect({ method: "POST" }, "/feeder-menu");
        }
    }

    res.type("text/xml");
    res.send(response.toString());
});

app.get("/admin", (req, res) => {
    const data = loadPrices();

    const contractsHtml = Object.entries(data.contracts)
        .sort((a, b) => {
            const typeA = a[1].type || "";
            const typeB = b[1].type || "";

            if (typeA !== typeB) {
                return typeA.localeCompare(typeB);
            }

            const orderA = Number(a[1].menuOrder || 999);
            const orderB = Number(b[1].menuOrder || 999);
            return orderA - orderB;
        })
        .map(([key, c]) => `
      <div style="border:1px solid #ccc; padding:15px; margin-bottom:15px; border-radius:8px;">
        <h3>${c.name}</h3>

        <p><strong>Type:</strong> ${c.type === "feeder" ? "Feeder Cattle" : "Live Cattle"}</p>

        <label>Current Price:</label><br>
        <input name="${key}" value="${c.current}" style="width:100%; padding:8px; font-size:16px;"><br>
        <small>
          Open: ${formatPrice(c.open)} |
          Close: ${formatPrice(c.close)} |
          Change: ${getChangeText(c)}
        </small>

        <br><br>

        <button
          type="submit"
          formaction="/admin/remove/${key}"
          formmethod="POST"
          onclick="return confirm('Remove ${c.name}?')"
          style="background:#b00020; color:white; padding:8px 12px; border:none; border-radius:5px;"
        >
          Remove Future
        </button>
      </div>
    `).join("");

    res.send(`
    <html>
      <head>
        <title>Cattle Line Admin</title>
      </head>

      <body style="font-family: Arial; max-width: 800px; margin: 30px auto; padding: 10px;">
        <h1>Cattle Line Price Update</h1>

        <form method="POST" action="/admin/update">
          <p><strong>Market Date:</strong> ${data.marketDate}</p>

          <h2>Current Futures</h2>

          ${contractsHtml || "<p>No futures added yet.</p>"}

          <button name="updateType" value="10am" style="padding:12px; margin:5px;">Save 10 AM Update</button>
          <button name="updateType" value="2pm" style="padding:12px; margin:5px;">Save 2 PM Update</button>
          <button name="updateType" value="close" style="padding:12px; margin:5px;">Save Close Update</button>
        </form>

        <hr style="margin:30px 0;">

        <h2>Add New Future</h2>

        <form method="POST" action="/admin/add">
          <label>Future Type:</label><br>
          <select name="type" style="width:100%; padding:8px; font-size:16px;">
            <option value="live">Live Cattle</option>
            <option value="feeder">Feeder Cattle</option>
          </select>

          <br><br>

          <label>Name callers will hear:</label><br>
          <input name="name" placeholder="Example: April 2026 Live Cattle" required style="width:100%; padding:8px; font-size:16px;">

          <br><br>

          <label>Starting / Current Price:</label><br>
          <input name="price" placeholder="Example: 248.300" required style="width:100%; padding:8px; font-size:16px;">

          <br><br>

          <label>Menu Order:</label><br>
          <input name="menuOrder" placeholder="Example: 1" value="1" style="width:100%; padding:8px; font-size:16px;">
          <small>This controls what number they press. 1 means Press 1, 2 means Press 2, etc.</small>

          <br><br>

          <button type="submit" style="padding:12px; background:#0057b8; color:white; border:none; border-radius:5px;">
            Add Future
          </button>
        </form>
      </body>
    </html>
  `);
});

app.post("/admin/update", (req, res) => {
    const data = loadPrices();

    data.lastUpdateType = req.body.updateType;

    for (const key of Object.keys(data.contracts)) {
        const newPrice = Number(req.body[key]);

        if (!Number.isNaN(newPrice)) {
            data.contracts[key].current = newPrice;

            if (req.body.updateType === "close") {
                data.contracts[key].close = newPrice;
            }
        }
    }

    savePrices(data);

    res.redirect("/admin");
});

app.post("/admin/add", (req, res) => {
    const data = loadPrices();

    const type = req.body.type === "feeder" ? "feeder" : "live";
    const name = String(req.body.name || "").trim();
    const price = Number(req.body.price);
    const menuOrder = Number(req.body.menuOrder || 999);

    if (!name || Number.isNaN(price)) {
        return res.redirect("/admin");
    }

    let key = `${type}_${safeKey(name)}`;
    let counter = 2;

    while (data.contracts[key]) {
        key = `${type}_${safeKey(name)}_${counter}`;
        counter++;
    }

    const finalMenuOrder = Number.isNaN(menuOrder) ? 999 : menuOrder;

    makeRoomForMenuOrder(data, type, finalMenuOrder);

    data.contracts[key] = {
        name,
        type,
        open: price,
        current: price,
        close: price,
        menuOrder: finalMenuOrder
    };

    renumberMenuOrders(data, type);

    savePrices(data);

    res.redirect("/admin");
});

function renumberMenuOrders(data, type) {
    const futures = Object.entries(data.contracts)
        .filter(([key, contract]) => contract.type === type)
        .sort((a, b) => Number(a[1].menuOrder || 999) - Number(b[1].menuOrder || 999));

    futures.forEach(([key, contract], index) => {
        data.contracts[key].menuOrder = index + 1;
    });
}

app.post("/admin/remove/:key", (req, res) => {
    const data = loadPrices();
    const key = req.params.key;

    if (data.contracts[key]) {
        const type = data.contracts[key].type;

        delete data.contracts[key];

        renumberMenuOrders(data, type);

        savePrices(data);
    }

    res.redirect("/admin");
});

app.post("/admin/new-day", (req, res) => {
    const data = loadPrices();

    for (const key of Object.keys(data.contracts)) {
        data.contracts[key].open = data.contracts[key].close;
        data.contracts[key].current = data.contracts[key].close;
    }

    data.lastUpdateType = "open";

    savePrices(data);

    res.redirect("/admin");
});

function getTodayDateText() {
    return new Date().toLocaleDateString("en-US", {
        timeZone: "America/Chicago",
        month: "long",
        day: "numeric",
        year: "numeric"
    });
}

function startNewMarketDayAutomatically() {
    const data = loadPrices();
    const today = getTodayDateText();

    if (data.marketDate === today && data.lastUpdateType === "open") {
        console.log("Market day already started:", today);
        return;
    }

    for (const key of Object.keys(data.contracts)) {
        data.contracts[key].open = data.contracts[key].close;
        data.contracts[key].current = data.contracts[key].close;
    }

    data.marketDate = today;
    data.lastUpdateType = "open";

    savePrices(data);

    console.log("New market day started automatically:", today);
}

cron.schedule("0 8 * * 1-5", () => {
    startNewMarketDayAutomatically();
}, {
    timezone: "America/Chicago"
});

//const chicagoNow = new Date().toLocaleString("en-US", {
  // timeZone: "America/Chicago"
//});

//const chicagoDay = new Date(chicagoNow).getDay();

//if (chicagoDay >= 1 && chicagoDay <= 5) {
   // startNewMarketDayAutomatically();
//}

app.listen(PORT, () => {
    console.log(`CattleLine running on http://localhost:${PORT}`);
    console.log(`Admin page: http://localhost:${PORT}/admin`);
});
