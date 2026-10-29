/* ============================================================
   zendure-sim.js — Simulations-Engine für zendure-simulation.html

   Teil 1 (ZendureManager, FuseGroup, ZendureDevice) ist eine
   möglichst wörtliche JavaScript-Portierung der Regelung aus der
   Home-Assistant-Integration Zendure-HA:
     Repository: https://github.com/Zendure/Zendure-HA
     Stand:      main @ 8d59bac (11.10.2026) – Regelcode identisch mit
                 Release 1.4.4 (Unterschied nur manifest.json), geprüft 29.10.2026
     Dateien:    custom_components/zendure_ha/manager.py
                 custom_components/zendure_ha/fusegroup.py
                 custom_components/zendure_ha/device.py
                 custom_components/zendure_ha/const.py
   Kommentare der Form "manager.py:446" verweisen auf die Zeilen im
   Original. Python-Ganzzahlarithmetik wird nachgebildet:
   int(x) → Math.trunc, a // b → Math.floor(a / b).

   Teil 2 (DevicePlant, Simulator) ist NICHT aus der Integration,
   sondern das physikalische Ersatzmodell, das in der echten Welt
   die Geräte, den Akku und den Netzzähler darstellt. Dessen
   Parameter (Reaktionszeit, Totzeit, Wirkungsgrade) sind Annahmen.

   Nicht modelliert: DC-Solareingang am Gerät (Bypass/SOCFULL-
   Durchleitung), Off-Grid-Steckdose, HEMS, Legacy-Geräte (Hyper,
   Hub), Kalibrierung. Bei reiner AC-Kopplung (PV über separaten
   Wechselrichter) spielen diese Pfade keine Rolle: pwr_produced
   ist dann immer 0.
   ============================================================ */
(function (root) {
    "use strict";

    /* ── const.py ─────────────────────────────────────────── */
    var SmartMode = {
        SOCFULL: 1,
        SOCEMPTY: 2,
        CONNECTED: 10,
        TIMEFAST: 2.2,          // s, schnelles Intervall nach großer Änderung
        TIMEZERO: 4,            // s, normales Intervall
        P1_STDDEV_FACTOR: 3.5,
        P1_STDDEV_MIN: 15,      // W
        POWER_START: 50,        // W, Mindestleistung zum Starten eines Geräts
        POWER_TOLERANCE: 5      // W, Toleranz bevor ein neuer Befehl gesendet wird
    };
    var DeviceState = { OFFLINE: 0, SOCEMPTY: 1, INACTIVE: 2, SOCFULL: 3, ACTIVE: 4 };
    var ManagerMode = { OFF: 0, MANUAL: 1, MATCHING: 2, MATCHING_DISCHARGE: 3, MATCHING_CHARGE: 4, STORE_SOLAR: 5 };
    var ManagerState = { IDLE: 0, CHARGE: 1, DISCHARGE: 2, OFF: 3 };

    var trunc = Math.trunc;
    function floorDiv(a, b) { return Math.floor(a / b); }
    function sum(arr) { var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i]; return s; }

    /* ── Gerätetypen (devices/*.py, setLimits) ─────────────── */
    /* charge/discharge: Grenzen, mit denen die Integration rechnet
       (setLimits in devices/*.py; das Gerät kann sie zur Laufzeit über
       chargeMaxLimit/inverseMaxPower überschreiben, device.py:274–277).
       hwCharge/hwDischarge: was das Gerät physikalisch umsetzt. Für den
       2400 AC+ laut Handbuch: Akku max. 2400 W Laden/Entladen, AC-Ausgang
       800 W Standard bzw. 2400 W mit Elektriker-Freigabe. Für die übrigen
       Typen sind die Hardware-Werte nicht geprüft (= Code-Werte). */
    var DEVICE_TYPES = {
        sf2400acplus: { label: "SolarFlow 2400 AC+", charge: -3200, discharge: 2400, hwCharge: 2400, hwDischarge: 2400, kWh: 8.16 },
        sf2400ac:     { label: "SolarFlow 2400 AC",  charge: -2400, discharge: 2400, hwCharge: 2400, hwDischarge: 2400, kWh: 5.76 },
        sf2400pro:    { label: "SolarFlow 2400 Pro", charge: -3200, discharge: 2400, hwCharge: 3200, hwDischarge: 2400, kWh: 5.76 },
        sf4000acplus: { label: "SolarFlow 4000 AC+", charge: -3200, discharge: 2400, hwCharge: 3200, hwDischarge: 2400, kWh: 8.0 },
        sf1600:       { label: "SolarFlow 1600",     charge: -1600, discharge: 1600, hwCharge: 1600, hwDischarge: 1600, kWh: 5.76 },
        sf800pro:     { label: "SolarFlow 800 Pro",  charge: -1000, discharge: 800,  hwCharge: 1000, hwDischarge: 800,  kWh: 1.92 }
    };

    /* Fuse-Group-Auswahl (manager.py:183–206) → [maxpower, minpower] */
    var FUSE_GROUPS = {
        owncircuit:   { label: "Eigener Stromkreis / Phase", max: 3600, min: -3600 },
        group800:     { label: "Gruppe max. 800 W",          max: 800,  min: -1200 },
        group800_2400:{ label: "Gruppe 800 W / Laden 2400 W", max: 800, min: -2400 },
        group1200:    { label: "Gruppe max. 1200 W",         max: 1200, min: -1200 },
        group2000:    { label: "Gruppe max. 2000 W",         max: 2000, min: -2000 },
        group2400:    { label: "Gruppe max. 2400 W",         max: 2400, min: -2400 },
        group3600:    { label: "Gruppe max. 3600 W",         max: 3600, min: -3600 },
        group4000:    { label: "Gruppe max. 4000 W",         max: 4000, min: -4000 },
        group5000:    { label: "Gruppe max. 5000 W",         max: 5000, min: -5000 },
        unused:       { label: "Nicht genutzt (kein Smart-Betrieb)", max: 0, min: 0 }
    };

    /* ════════════════════════════════════════════════════════
       TEIL 1 — Portierung der Integration
       ════════════════════════════════════════════════════════ */

    /* ── fusegroup.py ─────────────────────────────────────── */
    function FuseGroup(name, maxpower, minpower, devices) {
        this.name = name;
        this.maxpower = maxpower;
        this.minpower = minpower;
        this.initPower = true;
        this.devices = devices || [];
        for (var i = 0; i < this.devices.length; i++) this.devices[i].fuseGrp = this;
    }

    FuseGroup.prototype.charge_limit = function (d) {
        if (this.initPower) {
            this.initPower = false;
            if (this.devices.length === 1) {
                d.pwr_max = Math.max(this.minpower, d.charge_limit);
            } else {
                var limit = 0, weight = 0, fd, i;
                for (i = 0; i < this.devices.length; i++) {
                    fd = this.devices[i];
                    if (fd.homeInput > 0) {
                        limit += fd.charge_limit;
                        weight += (100 - fd.electricLevel) * fd.charge_limit;
                    }
                }
                var avail = Math.max(this.minpower, limit);
                for (i = 0; i < this.devices.length; i++) {
                    fd = this.devices[i];
                    if (fd.homeInput > 0) {
                        fd.pwr_max = weight < 0
                            ? trunc(avail * ((100 - fd.electricLevel) * fd.charge_limit) / weight)
                            : fd.charge_start;
                        limit -= fd.charge_limit;
                        if (limit > avail - fd.pwr_max) fd.pwr_max = Math.max(avail - limit, avail);
                        fd.pwr_max = Math.max(fd.pwr_max, fd.charge_limit);
                        avail -= fd.pwr_max;
                    }
                }
            }
        }
        return d.pwr_max;
    };

    FuseGroup.prototype.discharge_limit = function (d) {
        if (this.initPower) {
            this.initPower = false;
            if (this.devices.length === 1) {
                d.pwr_max = Math.min(this.maxpower, d.discharge_limit);
            } else {
                var limit = 0, weight = 0, fd, i;
                for (i = 0; i < this.devices.length; i++) {
                    fd = this.devices[i];
                    if (fd.homeOutput > 0) {
                        limit += fd.discharge_limit;
                        weight += fd.electricLevel * fd.discharge_limit;
                    }
                }
                var avail = Math.min(this.maxpower, limit);
                for (i = 0; i < this.devices.length; i++) {
                    fd = this.devices[i];
                    if (fd.homeOutput > 0) {
                        fd.pwr_max = weight > 0
                            ? trunc(avail * (fd.electricLevel * fd.discharge_limit) / weight)
                            : fd.discharge_start;
                        limit -= fd.discharge_limit;
                        if (limit < avail - fd.pwr_max) fd.pwr_max = Math.min(avail - limit, avail);
                        fd.pwr_max = Math.min(fd.pwr_max, fd.discharge_limit);
                        avail -= fd.pwr_max;
                    }
                }
            }
        }
        return d.pwr_max;
    };

    /* ── device.py: ZendureDevice + ZendureZenSdk ─────────────
       Sicht der Integration auf ein Gerät. Die Messwerte (homeInput,
       homeOutput, electricLevel …) liefert das Ersatzmodell (DevicePlant),
       die Befehle (acMode, inputLimit, outputLimit) gehen dorthin. */
    function ZendureDevice(cfg, plant, logger) {
        this.deviceId = cfg.id;
        this.name = cfg.name;
        this.plant = plant;
        this.log = logger;
        this.kWh = cfg.kWh;
        this.minSoc = cfg.minSoc;
        this.socSet = cfg.socSet;
        this.fuseGroupSel = cfg.fuseGroup;     // Schlüssel aus FUSE_GROUPS oder "part:<id>"
        this.fuseGrp = null;
        this.pwr_max = 0;
        this.pwr_produced = 0;
        this.state = DeviceState.INACTIVE;
        this.actualKwh = 0;
        this.exports_bypass = true;
        this.byPass = 0;
        this.setLimits(cfg.chargeLimit, cfg.dischargeLimit);
        // manager.py:131–132 überschreibt discharge_start/optimal nach dem Laden
        this.discharge_start = floorDiv(this.discharge_limit, 10);
        this.discharge_optimal = floorDiv(this.discharge_limit, 4);
    }

    ZendureDevice.prototype.setLimits = function (charge, discharge) {   // device.py:204
        this.charge_limit = charge;
        this.charge_optimal = floorDiv(charge, 4);
        this.charge_start = floorDiv(charge, 10);
        this.discharge_limit = discharge;
        this.discharge_optimal = floorDiv(discharge, 4);
        this.discharge_start = floorDiv(discharge, 10);
    };

    // Messwerte: immer aktuell aus dem Ersatzmodell (Integer wie vom Gerät gemeldet)
    Object.defineProperties(ZendureDevice.prototype, {
        homeInput:      { get: function () { return this.plant.homeInput; } },
        homeOutput:     { get: function () { return this.plant.homeOutput; } },
        batteryInput:   { get: function () { return this.plant.batteryInput; } },
        batteryOutput:  { get: function () { return this.plant.batteryOutput; } },
        solarInput:     { get: function () { return 0; } },
        electricLevel:  { get: function () { return this.plant.electricLevel; } },
        limitInput:     { get: function () { return this.plant.cmd.inputLimit; } },
        limitOutput:    { get: function () { return this.plant.cmd.outputLimit; } },
        pwr_offgrid:    { get: function () { return 0; } },
        online:         { get: function () { return this.fuseGrp !== null; } },  // setStatus(): No FuseGroup → nicht online
        availableKwh:   { get: function () { return (this.electricLevel - this.minSoc) / 100 * this.kWh; } }
    });

    ZendureDevice.prototype.power_get = function () {                   // device.py:636
        this.actualKwh = this.availableKwh;
        if (!this.online || this.socSet === 0 || this.kWh === 0) {
            this.state = DeviceState.OFFLINE;
        } else if (this.plant.socLimit === SmartMode.SOCFULL || this.electricLevel >= this.socSet) {
            this.state = DeviceState.SOCFULL;
        } else if (this.plant.socLimit === SmartMode.SOCEMPTY || this.electricLevel <= this.minSoc) {
            this.state = DeviceState.SOCEMPTY;
        } else {
            this.state = DeviceState.INACTIVE;
        }
        return this.state !== DeviceState.OFFLINE;
    };

    ZendureDevice.prototype.power_charge = function (power) {            // device.py:659
        power = Math.min(0, Math.max(power, this.charge_limit));
        if (Math.abs(power + this.homeInput - this.homeOutput) <= SmartMode.POWER_TOLERANCE) {
            this.log("dev", "Power charge " + this.name + " => no action [power " + power + "]");
            return -this.homeInput;
        }
        return this.charge(power);
    };

    ZendureDevice.prototype.power_discharge = function (power) {         // device.py:672
        power = Math.max(0, Math.min(power, this.discharge_limit));
        if (Math.abs(power - this.homeOutput + this.homeInput) <= SmartMode.POWER_TOLERANCE) {
            this.log("dev", "Power discharge " + this.name + " => no action [power " + power + "]");
            return this.homeOutput;
        }
        return this.discharge(power);
    };

    ZendureDevice.prototype.charge = function (power) {                  // device.py:784 (ZenSdk)
        this.log("cmd", "Power charge " + this.name + " => " + power);
        if (power === -SmartMode.POWER_START && this.limitInput >= SmartMode.POWER_START && this.homeInput === 0) {
            power = -Math.min(this.limitInput + 4, 2 * SmartMode.POWER_START);
            this.log("cmd", "Power charge kickstart " + this.name + " => " + power);
        }
        this.plant.command({ smartMode: power === 0 && this.pwr_offgrid === 0 ? 0 : 1, acMode: 1, outputLimit: 0, inputLimit: -power });
        return power;
    };

    ZendureDevice.prototype.discharge = function (power) {               // device.py:793 (ZenSdk)
        this.log("cmd", "Power discharge " + this.name + " => " + power);
        if (power === SmartMode.POWER_START && this.limitOutput >= SmartMode.POWER_START && this.homeOutput === 0) {
            power = Math.min(this.limitOutput + 4, 2 * SmartMode.POWER_START);
            this.log("cmd", "Power discharge kickstart " + this.name + " => " + power);
        }
        this.plant.command({ smartMode: power === 0 && this.pwr_offgrid === 0 ? 0 : 1, acMode: 2, outputLimit: power, inputLimit: 0 });
        return power;
    };

    ZendureDevice.prototype.power_off = function () {
        this.plant.command({ smartMode: 0, acMode: 2, outputLimit: 0, inputLimit: 0 });
    };

    /* ── manager.py: ZendureManager ───────────────────────── */
    function ZendureManager(devices, logger) {
        this.devices = devices;
        this.log = logger;
        this.operation = ManagerMode.MATCHING;
        this.operationstate = ManagerState.IDLE;
        this.manualpower = 0;
        this.zero_next = -Infinity;          // datetime.min
        this.zero_fast = -Infinity;
        this.p1_history = [25, -25];         // deque([25, -25], maxlen=8)

        this.charge = [];
        this.charge_limit = 0;
        this.charge_optimal = 0;
        this.charge_time = Infinity;         // datetime.max
        this.charge_last = -Infinity;        // datetime.min
        this.charge_weight = 0;

        this.discharge = [];
        this.discharge_bypass = 0;
        this.discharge_produced = 0;
        this.discharge_limit = 0;
        this.discharge_optimal = 0;
        this.discharge_weight = 0;

        this.idle = [];
        this.idle_lvlmax = 0;
        this.idle_lvlmin = 0;
        this.produced = 0;
        this.pwr_low = 0;

        this.power = 0;
        this.availableKwh = 0;
        this.globalSoc = 0;
        this.lastSetpoint = 0;
        this.lastRun = -Infinity;
        this.runs = 0;

        this.fuseGroups = [];
        this.update_fusegroups();
    }

    ZendureManager.prototype.update_fusegroups = function () {            // manager.py:169
        var fuseGroups = {}, order = [], i, d, fg, sel;
        for (i = 0; i < this.devices.length; i++) this.devices[i].fuseGrp = null;

        for (i = 0; i < this.devices.length; i++) {
            d = this.devices[i];
            sel = d.fuseGroupSel;
            if (sel === "unused") { if (this.operation !== ManagerMode.OFF) d.power_off(); continue; }
            var def = FUSE_GROUPS[sel];
            if (!def) continue;                                  // "Part of …" → später zuordnen
            fg = new FuseGroup(d.name, def.max, def.min);
            fg.devices.push(d);
            fuseGroups[d.deviceId] = fg;
            order.push(d.deviceId);
        }
        // Add devices to fusegroups (manager.py:241)
        for (i = 0; i < this.devices.length; i++) {
            d = this.devices[i];
            if (typeof d.fuseGroupSel === "string" && d.fuseGroupSel.indexOf("part:") === 0) {
                fg = fuseGroups[d.fuseGroupSel.slice(5)];
                if (fg) { d.fuseGrp = fg; fg.devices.push(d); }
            }
        }
        // check if we can split fuse groups (manager.py:248)
        this.fuseGroups = [];
        for (i = 0; i < order.length; i++) {
            fg = fuseGroups[order[i]];
            var sumDis = sum(fg.devices.map(function (x) { return x.discharge_limit; }));
            var sumCh = sum(fg.devices.map(function (x) { return x.charge_limit; }));
            if (fg.devices.length > 1 && fg.maxpower >= sumDis && fg.minpower <= sumCh) {
                for (var k = 0; k < fg.devices.length; k++) {
                    var x = fg.devices[k];
                    this.fuseGroups.push(new FuseGroup(x.name, x.discharge_limit, x.charge_limit, [x]));
                }
                fg.split = true;
            } else {
                for (var j = 0; j < fg.devices.length; j++) fg.devices[j].fuseGrp = fg;
                this.fuseGroups.push(fg);
            }
        }
    };

    ZendureManager.prototype.setOperation = function (mode) {
        this.operation = mode;
        if (mode === ManagerMode.OFF) {
            this.operationstate = ManagerState.OFF;
            for (var i = 0; i < this.devices.length; i++) this.devices[i].power_off();
        }
    };

    ZendureManager.prototype.p1Changed = function (p1, time) {           // manager.py:367 _p1_changed
        // Check for fast delay
        if (time < this.zero_fast) { this.pushHistory(p1); return; }

        // calculate the standard deviation
        var isFast = false, h = this.p1_history;
        if (h.length > 1) {
            var avg = trunc(sum(h) / h.length);
            var variance = 0;
            for (var i = 0; i < h.length; i++) variance += Math.pow(h[i] - avg, 2);
            var stddev = SmartMode.P1_STDDEV_FACTOR * Math.max(SmartMode.P1_STDDEV_MIN, Math.sqrt(variance / h.length));
            isFast = Math.abs(p1 - avg) > stddev || Math.abs(p1 - h[0]) > stddev;
            if (isFast) this.p1_history = [];
        }
        this.pushHistory(p1);

        // check minimal time between updates
        if (isFast || time > this.zero_next) {
            this.zero_fast = Infinity;
            this.charge = []; this.charge_limit = 0; this.charge_optimal = 0; this.charge_weight = 0;
            this.discharge = []; this.discharge_bypass = 0; this.discharge_limit = 0;
            this.discharge_optimal = 0; this.discharge_produced = 0; this.discharge_weight = 0;
            this.idle = []; this.idle_lvlmax = 0; this.idle_lvlmin = 100;
            this.produced = 0;
            for (var f = 0; f < this.fuseGroups.length; f++) this.fuseGroups[f].initPower = true;
            this.powerChanged(p1, isFast, time);
            this.zero_next = time + SmartMode.TIMEZERO;
            this.zero_fast = time + SmartMode.TIMEFAST;
            this.lastRun = time;
            this.runs++;
        }
    };

    ZendureManager.prototype.pushHistory = function (p1) {
        this.p1_history.push(p1);
        if (this.p1_history.length > 8) this.p1_history.shift();
    };

    ZendureManager.prototype.powerChanged = function (p1, isFast, time) { // manager.py:427
        var availableKwh = 0, setpoint = p1, power = 0, totalStoredkWh = 0, onlinekWh = 0;

        for (var i = 0; i < this.devices.length; i++) {
            var d = this.devices[i], home = 0;
            if (!d.power_get()) continue;
            d.pwr_produced = Math.min(0, d.batteryOutput + d.homeInput - d.batteryInput - d.homeOutput);
            if (d.state === DeviceState.SOCFULL && -d.solarInput < d.pwr_produced) d.pwr_produced = -d.solarInput;
            this.produced -= d.pwr_produced;

            if ((home = -d.homeInput + Math.max(0, d.pwr_offgrid)) < 0) {
                this.charge.push(d);
                this.charge_limit += d.fuseGrp.charge_limit(d);
                this.charge_optimal += d.charge_optimal;
                this.charge_weight += d.pwr_max * (100 - d.electricLevel);
                setpoint -= Math.min(d.homeInput, d.batteryInput);
            } else if ((home = d.homeOutput) > 0) {
                this.discharge.push(d);
                if (d.state === DeviceState.SOCFULL && d.exports_bypass) this.discharge_bypass += Math.min(-d.pwr_produced, home);
                this.discharge_limit += d.fuseGrp.discharge_limit(d);
                this.discharge_optimal += d.discharge_optimal;
                this.discharge_produced -= d.pwr_produced;
                this.discharge_weight += d.pwr_max * d.electricLevel;
                setpoint += home;
            } else {
                this.idle.push(d);
                this.idle_lvlmax = Math.max(this.idle_lvlmax, d.electricLevel);
                this.idle_lvlmin = Math.min(this.idle_lvlmin, d.state !== DeviceState.SOCFULL ? d.electricLevel : 100);
            }
            availableKwh += d.actualKwh;
            power += d.pwr_offgrid + home + d.pwr_produced;
            totalStoredkWh += d.electricLevel / 100 * d.kWh;
            onlinekWh += d.kWh;
        }

        this.power = power;
        this.availableKwh = availableKwh;
        this.globalSoc = onlinekWh > 0 ? totalStoredkWh / onlinekWh * 100 : 0;

        setpoint -= this.discharge_bypass;
        this.lastSetpoint = setpoint;

        this.log("p1", "P1 ======> p1:" + p1 + " isFast:" + (isFast ? "True" : "False") + ", setpoint:" + setpoint + "W stored:" + this.produced + "W");
        switch (this.operation) {
            case ManagerMode.MATCHING:
                if (setpoint < 0) this.power_charge(setpoint, time);
                else this.power_discharge(setpoint);
                break;
            case ManagerMode.MATCHING_DISCHARGE:
                this.power_discharge(Math.max(this.produced, setpoint));
                break;
            case ManagerMode.MATCHING_CHARGE:
            case ManagerMode.STORE_SOLAR:
                if (setpoint > 0 && this.produced > SmartMode.POWER_START && this.operation === ManagerMode.MATCHING_CHARGE) {
                    this.power_discharge(Math.min(this.produced, setpoint));
                } else {
                    this.power_charge(Math.min(0, setpoint), time);
                }
                break;
            case ManagerMode.MANUAL:
                setpoint = trunc(this.manualpower);
                if (setpoint > 0) this.power_discharge(setpoint);
                else this.power_charge(setpoint, time);
                break;
            case ManagerMode.OFF:
                this.operationstate = ManagerState.OFF;
                break;
        }
    };

    ZendureManager.prototype.power_charge = function (setpoint, time) {   // manager.py:521
        this.log("mgr", "Charge => setpoint " + setpoint + "W");
        var i, d;

        // stop discharging devices
        for (i = 0; i < this.discharge.length; i++) {
            d = this.discharge[i];
            if (d.byPass > 0) continue;
            d.power_discharge(d.pwr_offgrid === 0 ? 0 : -10);
        }

        // prevent hysteria
        if (this.charge_time > time) {
            if (this.charge_time === Infinity) {
                this.charge_time = time + ((time - this.charge_last) > 300 ? 2 : 60);
                this.charge_last = this.charge_time;
                this.pwr_low = 0;
                this.log("mgr", "Lade-Hysterese: Laden frühestens in " + (this.charge_time - time) + " s");
            }
            setpoint = 0;
        }
        this.operationstate = setpoint < 0 ? ManagerState.CHARGE : ManagerState.IDLE;

        // distribute charging devices
        var dev_start = setpoint < -SmartMode.POWER_START ? Math.min(0, setpoint - this.charge_optimal * 2) : 0;
        var limit = this.charge_limit;
        setpoint = Math.max(limit, setpoint);
        var sorted = this.charge.slice().sort(function (a, b) { return b.electricLevel - a.electricLevel; });
        for (i = 0; i < sorted.length; i++) {
            d = sorted[i];
            var device_weight = d.pwr_max * (100 - d.electricLevel);
            var pwr = this.charge_weight !== 0 ? trunc(setpoint * device_weight / this.charge_weight) : 0;
            this.charge_weight -= device_weight;

            limit -= d.pwr_max;
            pwr = Math.max(pwr, setpoint, d.pwr_max);
            if (limit > setpoint - pwr) pwr = Math.max(setpoint - limit, setpoint, d.pwr_max);

            // make sure we have devices in optimal working range
            // Hinweis: pwr_low ist hier immer ≥ 0, charge_optimal aber negativ
            // (z. B. −800). Die Abschaltbedingung greift daher beim Laden nie –
            // im Original genauso (manager.py:567–569), vermutlich Vorzeichenfehler.
            if (this.charge.length > 1 && i === 0) {
                var delta = d.charge_start * 1.5 - pwr;
                this.pwr_low = delta >= 0 ? 0 : this.pwr_low + trunc(-delta);
                pwr = this.pwr_low < d.charge_optimal ? 0 : pwr;
            }

            setpoint -= d.power_charge(pwr);
            dev_start += (pwr !== 0 && d.electricLevel > this.idle_lvlmin + 3) ? -1 : 0;
        }

        // start idle device if needed
        if (dev_start < 0 && this.idle.length > 0) {
            this.idle.sort(function (a, b) { return a.electricLevel - b.electricLevel; });
            for (i = 0; i < this.idle.length; i++) {
                d = this.idle[i];
                var start_pwr = SmartMode.POWER_START;
                this.log("mgr", "Starte Gerät " + d.name + " zum Laden");
                d.power_charge(d.state !== DeviceState.SOCFULL ? -start_pwr - Math.max(0, d.pwr_offgrid) : -Math.max(0, d.pwr_offgrid));
                if ((dev_start = dev_start - d.charge_optimal * 2) >= 0) break;
            }
            this.pwr_low = 0;
        }
    };

    ZendureManager.prototype.power_discharge = function (setpoint) {      // manager.py:587
        this.log("mgr", "Discharge => setpoint " + setpoint + "W");
        this.operationstate = (setpoint > 0 && this.discharge.length) ? ManagerState.DISCHARGE : ManagerState.IDLE;
        var i, d;

        // reset hysteria time
        if (this.charge_time !== Infinity) {
            this.charge_time = Infinity;
            this.pwr_low = 0;
        }

        // stop charging devices
        for (i = 0; i < this.charge.length; i++) {
            d = this.charge[i];
            d.power_discharge(Math.max(0, d.pwr_offgrid) === 0 ? 0 : 10);
        }

        // distribute discharging devices, use produced power first
        var dev_start = setpoint > SmartMode.POWER_START
            ? Math.max(0, setpoint - this.discharge_optimal * 2 - this.discharge_produced) : 0;
        var solaronly = this.discharge_produced >= setpoint;
        var limit = solaronly ? this.discharge_produced : this.discharge_limit;
        setpoint = Math.min(limit, setpoint);
        var sorted = this.discharge.slice().sort(function (a, b) { return a.electricLevel - b.electricLevel; });
        for (i = 0; i < sorted.length; i++) {
            d = sorted[i];
            var device_weight = d.pwr_max * d.electricLevel, pwr;
            if (this.discharge_weight !== 0) pwr = trunc(setpoint * device_weight / this.discharge_weight);
            else if (this.discharge.length > i) pwr = trunc(setpoint / (this.discharge.length - i));
            else pwr = 0;
            if (pwr < -d.pwr_produced && d.state === DeviceState.SOCFULL) pwr = -d.pwr_produced;
            this.discharge_weight -= device_weight;

            limit -= solaronly ? -d.pwr_produced : d.pwr_max;
            if (limit < setpoint - pwr) pwr = Math.max(setpoint - limit, d.state !== DeviceState.SOCFULL ? 0 : -d.pwr_produced);
            pwr = Math.min(pwr, setpoint, d.pwr_max);

            // make sure we have devices in optimal working range
            if (this.discharge.length > 1 && i === 0 && d.state !== DeviceState.SOCFULL) {
                var delta = d.discharge_start * 1.5 - pwr;
                this.pwr_low = delta <= 0 ? 0 : this.pwr_low + trunc(delta);
                pwr = this.pwr_low > d.discharge_optimal ? 0 : pwr;
            }

            setpoint -= d.power_discharge(pwr);
            dev_start += (pwr !== 0 && d.electricLevel + 3 < this.idle_lvlmax) ? 1 : 0;
        }

        // start idle device if needed
        if (dev_start > 0 && this.idle.length > 0) {
            this.idle.sort(function (a, b) { return b.electricLevel - a.electricLevel; });
            for (i = 0; i < this.idle.length; i++) {
                d = this.idle[i];
                if (d.state !== DeviceState.SOCEMPTY) {
                    this.log("mgr", "Starte Gerät " + d.name + " zum Entladen");
                    d.power_discharge(SmartMode.POWER_START);
                    if ((dev_start = dev_start - d.discharge_optimal * 2) <= 0) break;
                }
            }
            this.pwr_low = 0;
        }
    };

    /* ════════════════════════════════════════════════════════
       TEIL 2 — Ersatzmodell (nicht aus der Integration)
       ════════════════════════════════════════════════════════ */

    /* Ein Gerät aus Sicht der Physik: setzt den zuletzt empfangenen
       Befehl nach einer Totzeit um, folgt ihm mit einem PT1-Verhalten,
       hält Hardware- und SoC-Grenzen ein und integriert den Ladestand.
       Die Hardware-Grenzen (hwCharge/hwDischarge) sind bewusst getrennt
       von den Grenzen, mit denen die Integration rechnet: Der Code trägt
       z. B. für den 2400 AC+ −3200 W ein (max. AC-Eingang inkl. Off-Grid-
       Durchleitung), der Akku selbst lädt laut Handbuch aber mit max. 2400 W. */
    function DevicePlant(cfg, phys, onEvent) {
        this.kWh = cfg.kWh;
        this.minSoc = cfg.minSoc;
        this.socSet = cfg.socSet;
        this.hwCharge = -Math.abs(cfg.hwChargeLimit != null ? cfg.hwChargeLimit : cfg.chargeLimit);
        this.hwDischarge = Math.abs(cfg.hwDischargeLimit != null ? cfg.hwDischargeLimit : cfg.dischargeLimit);
        this.soc = cfg.startSoc;                   // % (Gleitkomma, intern)
        this.phys = phys;
        this.onEvent = onEvent || function () {};
        this.cmd = { smartMode: 0, acMode: 2, outputLimit: 0, inputLimit: 0 };
        this.cmdTarget = null;
        this.pending = [];                         // Befehle in der Totzeit
        this.p = 0;                                // AC-Leistung, + = ins Haus, − = aus dem Netz
        this.packState = 0;                        // 0 Ruhe, 1 Laden, 2 Entladen (wie Gerät meldet)
        this.lastDir = 0;
        this.switchCount = 0;                      // wie Integration: packState wechselt auf 0
        this.flipCount = 0;                        // Richtungswechsel Laden ↔ Entladen
        this.eIn = 0; this.eOut = 0;               // Wh AC
        this.socLimit = 0;
        this.now = 0;
        this.update();
    }

    DevicePlant.prototype.command = function (c) {
        this.pending.push({ at: this.now + this.phys.deadTime, c: c });
        this.cmdTarget = c;                         // zuletzt gesendet (für Anzeige)
    };

    DevicePlant.prototype.step = function (t, dt) {
        this.now = t;
        while (this.pending.length && this.pending[0].at <= t) {
            var c = this.pending.shift().c;
            this.cmd = { smartMode: c.smartMode, acMode: c.acMode, outputLimit: c.outputLimit, inputLimit: c.inputLimit };
        }
        var target = this.cmd.acMode === 1 ? -this.cmd.inputLimit : this.cmd.outputLimit;
        target = Math.max(this.hwCharge, Math.min(this.hwDischarge, target));
        if (target > 0 && this.soc <= this.minSoc) target = 0;   // Gerät/BMS stoppt bei minSoc
        if (target < 0 && this.soc >= this.socSet) target = 0;   // … und bei socSet

        var a = 1 - Math.exp(-dt / Math.max(0.05, this.phys.tau));
        this.p += (target - this.p) * a;
        if (Math.abs(this.p - target) < 0.5) this.p = target;

        // Ladestand integrieren
        var e;
        if (this.p > 0) {
            e = this.p / this.phys.etaDis * dt / 3600;              // Wh aus dem Akku
            this.soc -= e / (this.kWh * 1000) * 100;
            this.eOut += this.p * dt / 3600;
        } else if (this.p < 0) {
            e = -this.p * this.phys.etaCh * dt / 3600;              // Wh in den Akku
            this.soc += e / (this.kWh * 1000) * 100;
            this.eIn += -this.p * dt / 3600;
        }
        this.soc = Math.max(0, Math.min(100, this.soc));

        // packState wie vom Gerät gemeldet; die Integration zählt jeden
        // Wechsel auf 0 als Schaltvorgang (device.py:252, aggrSwitchCount)
        var ps = this.homeOutputRaw() > 0 ? 2 : this.homeInputRaw() > 0 ? 1 : 0;
        if (ps !== this.packState) {
            if (ps === 0) { this.switchCount++; this.onEvent("idle", t); }
            else if (this.packState === 0) this.onEvent(ps === 1 ? "startCh" : "startDis", t);
            if (ps !== 0 && this.lastDir !== 0 && ps !== this.lastDir) { this.flipCount++; this.onEvent("flip", t); }
            if (ps !== 0) this.lastDir = ps;
            this.packState = ps;
        }
        this.update();
    };

    DevicePlant.prototype.homeOutputRaw = function () { return Math.max(0, Math.round(this.p)); };
    DevicePlant.prototype.homeInputRaw = function () { return Math.max(0, Math.round(-this.p)); };

    DevicePlant.prototype.update = function () {
        this.homeOutput = this.homeOutputRaw();
        this.homeInput = this.homeInputRaw();
        this.batteryOutput = this.p > 0 ? Math.round(this.p / this.phys.etaDis) : 0;
        this.batteryInput = this.p < 0 ? Math.round(-this.p * this.phys.etaCh) : 0;
        this.electricLevel = Math.round(this.soc);
        this.socLimit = this.soc >= this.socSet ? SmartMode.SOCFULL : this.soc <= this.minSoc ? SmartMode.SOCEMPTY : 0;
    };

    /* Gesamtsystem: Haus (Last, PV, Wallbox), Geräte, Netzzähler, Manager.
       Der Verlauf wird ab dem Start vollständig aufgezeichnet (1 Wert/s).
       Nach 48 h Simulationszeit wird die Auflösung jeweils halbiert
       (Mittelwert je zwei Punkte), damit der Speicher nicht überläuft.
       Ereignisse (Start, Ruhe, Richtungswechsel) werden immer exakt
       gespeichert – unabhängig von der Auflösung des Verlaufs. */
    var SERIES_LIMIT = 48 * 3600;

    function Simulator(config) {
        this.logLines = [];
        this.reset(config);
    }

    Simulator.prototype.reset = function (config) {
        var self = this;
        this.config = config;
        this.t = 0;
        this.nextMeter = 0;
        this.p1 = 0;
        this.lastReported = null;
        this.meterEvents = 0;
        this.sampleEvery = 1;
        this.series = { t: [], p1: [], pv: [], load: [], setpoint: [], dev: [], soc: [] };
        this.events = [];
        this.nextSample = 0;
        this.stats = { both: 0, any: 0, eImport: 0, eExport: 0 };
        this.logLines = [];
        var logger = function (kind, msg) { self.addLog(kind, msg); };
        this.plants = [];
        this.devices = config.devices.map(function (c, idx) {
            var pl = new DevicePlant(c, config.phys, function (kind, t) {
                if (self.events.length < 500000) self.events.push({ t: t, dev: idx, kind: kind });
            });
            self.plants.push(pl);
            return new ZendureDevice(c, pl, logger);
        });
        this.devices.forEach(function () { self.series.dev.push([]); self.series.soc.push([]); });
        this.manager = new ZendureManager(this.devices, logger);
        this.manager.operation = config.mode;
        this.manager.manualpower = config.manualPower || 0;
        this.noiseState = 0;
        this.cloud = 1;
        this.spikeUntil = -1;
    };

    Simulator.prototype.addLog = function (kind, msg) {
        this.logLines.push({ t: this.t, kind: kind, msg: msg });
        if (this.logLines.length > 400) this.logLines.splice(0, this.logLines.length - 400);
    };

    Simulator.prototype.inputs = function () {
        var s = this.config.scene;
        var pv = s.pv * (s.clouds ? this.cloud : 1);
        var load = s.load + (this.t < this.spikeUntil ? s.spikePower : 0);
        return { pv: pv, load: load, wallbox: s.wallbox };
    };

    Simulator.prototype.gridPower = function () {
        var inp = this.inputs(), batt = 0;
        for (var i = 0; i < this.plants.length; i++) batt += this.plants[i].p;
        return inp.load + inp.wallbox - inp.pv - batt;            // + = Bezug, − = Einspeisung
    };

    Simulator.prototype.step = function (dt) {
        var s = this.config.scene, i;
        this.t += dt;
        // Wolkenzug: langsamer Zufallsprozess zwischen 0,15 und 1
        if (s.clouds) {
            this.cloud += (Math.random() - 0.5) * 0.12 * Math.sqrt(dt) + (0.75 - this.cloud) * 0.01 * dt;
            this.cloud = Math.max(0.15, Math.min(1, this.cloud));
        }
        for (i = 0; i < this.plants.length; i++) this.plants[i].step(this.t, dt);

        var grid = this.gridPower();
        if (grid > 0) this.stats.eImport += grid * dt / 3600; else this.stats.eExport += -grid * dt / 3600;
        var active = 0;
        for (i = 0; i < this.plants.length; i++) if (Math.abs(this.plants[i].p) > 1) active++;
        if (active >= 1) this.stats.any += dt;
        if (active >= 2) this.stats.both += dt;

        // Netzzähler: neuer Messwert im Zählertakt. Home Assistant löst
        // state_changed (und damit _p1_changed) nur aus, wenn sich der Wert
        // gegenüber dem letzten Zustand ändert – gleiche Werte erreichen den
        // Manager nicht.
        if (this.t >= this.nextMeter) {
            this.nextMeter = this.t + this.config.phys.meterInterval;
            this.noiseState = s.noise > 0 ? (Math.random() * 2 - 1) * s.noise : 0;
            this.p1 = Math.round(grid + this.noiseState);
            if (this.p1 !== this.lastReported) {
                this.lastReported = this.p1;
                this.meterEvents++;
                this.manager.p1Changed(this.p1, this.t);
            }
        }

        if (this.t >= this.nextSample) {
            this.nextSample += this.sampleEvery;
            var inp = this.inputs(), sr = this.series;
            sr.t.push(this.t);
            sr.p1.push(this.p1);
            sr.pv.push(inp.pv);
            sr.load.push(inp.load + inp.wallbox);
            sr.setpoint.push(this.manager.lastSetpoint);
            for (i = 0; i < this.plants.length; i++) {
                sr.dev[i].push(this.plants[i].p);
                sr.soc[i].push(this.plants[i].soc);
            }
            if (sr.t.length > SERIES_LIMIT) this.decimate();
        }
    };

    Simulator.prototype.decimate = function () {
        var sr = this.series;
        function half(arr) {
            var out = new Array(Math.floor(arr.length / 2));
            for (var k = 0; k < out.length; k++) out[k] = (arr[2 * k] + arr[2 * k + 1]) / 2;
            return out;
        }
        sr.t = half(sr.t); sr.p1 = half(sr.p1); sr.pv = half(sr.pv); sr.load = half(sr.load); sr.setpoint = half(sr.setpoint);
        sr.dev = sr.dev.map(half); sr.soc = sr.soc.map(half);
        this.sampleEvery *= 2;
    };

    Simulator.prototype.advance = function (seconds) {
        var dt = this.config.phys.dt || 0.1, n = Math.max(1, Math.round(seconds / dt));
        for (var i = 0; i < n; i++) this.step(dt);
    };

    Simulator.prototype.spike = function () { this.spikeUntil = this.t + this.config.scene.spikeDuration; };

    var api = {
        SmartMode: SmartMode, DeviceState: DeviceState, ManagerMode: ManagerMode, ManagerState: ManagerState,
        DEVICE_TYPES: DEVICE_TYPES, FUSE_GROUPS: FUSE_GROUPS,
        FuseGroup: FuseGroup, ZendureDevice: ZendureDevice, ZendureManager: ZendureManager,
        DevicePlant: DevicePlant, Simulator: Simulator,
        SOURCE: { repo: "https://github.com/Zendure/Zendure-HA", commit: "8d59bac", date: "11.10.2026" }
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    else root.ZendureSim = api;
})(this);
