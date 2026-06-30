const MODULE_ID = "hp-triggers";

function isDnd5e() {
    return game?.system?.id === "dnd5e";
}

/* ------------------- Activity Activation: At HP ------------------- */
const WH_AT_HP_ACTIVATION = "atHp";
const WH_AT_HP_GROUP = "hpTriggers";
const WH_PREVIOUS_HP = new Map();

function applyAtHpActivationConfig() {
    if (!isDnd5e()) return;
    const config = game.dnd5e?.config ?? CONFIG.DND5E;
    if (!config) return;

    const atHpData = {
        label: "At HP",
        name: "At HP",
        group: WH_AT_HP_GROUP
    };

    for (const key of ["activityActivationGroups", "activationGroups", "activityGroups"]) {
        const groups = config[key];
        if (groups && typeof groups === "object") groups[WH_AT_HP_GROUP] = "HP Triggers";
    }

    // dnd5e has changed this config shape a few times. Add the option to both
    // the flat activation lists and any nested special group lists we can find.
    for (const key of [
        "activityActivationTypes",
        "activityActivationCostTypes",
        "activityActivationOptions",
        "activationTypes",
        "itemActivationTypes",
        "abilityActivationTypes"
    ]) {
        const target = config[key];
        if (!target || typeof target !== "object") continue;

        const sample = Object.values(target).find(v => v && typeof v === "object" && !Array.isArray(v));
        target[WH_AT_HP_ACTIVATION] = sample ? { ...sample, ...atHpData } : "At HP";

        for (const group of Object.values(target)) {
            if (!group || typeof group !== "object") continue;
            for (const prop of ["types", "choices", "options"]) {
                if (group[prop] && typeof group[prop] === "object") group[prop][WH_AT_HP_ACTIVATION] = "At HP";
            }
        }
    }
}

function getActorHpValue(actor) {
    const value = foundry.utils.getProperty(actor, "system.attributes.hp.value");
    return Number.isFinite(Number(value)) ? Number(value) : null;
}

function getActivityActivation(activity) {
    return activity?.activation
        ?? activity?.system?.activation
        ?? activity?.toObject?.()?.activation
        ?? activity?.toObject?.()?.system?.activation
        ?? {};
}

function getAtHpThreshold(activity) {
    const activation = getActivityActivation(activity);
    const flagValue = activity?.getFlag?.(MODULE_ID, "atHpThreshold")
        ?? activity?.flags?.[MODULE_ID]?.atHpThreshold
    const raw = flagValue ?? activation?.threshold ?? activation?.hp;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

async function setAtHpThreshold(activity, value) {
    const clean = String(value ?? "").trim();
    if (!activity) return;

    if (clean === "") {
        if (typeof activity.unsetFlag === "function") return activity.unsetFlag(MODULE_ID, "atHpThreshold");
        if (typeof activity.update === "function") return activity.update({ [`flags.${MODULE_ID}.-=atHpThreshold`]: null });
        return;
    }

    const numeric = Number(clean);
    if (!Number.isFinite(numeric)) return ui.notifications.warn("HP Triggers | At HP must be a number.");

    if (typeof activity.setFlag === "function") return activity.setFlag(MODULE_ID, "atHpThreshold", numeric);
    if (typeof activity.update === "function") return activity.update({ [`flags.${MODULE_ID}.atHpThreshold`]: numeric });
}

function getAtHpOperator(activity) {
    const raw = activity?.getFlag?.(MODULE_ID, "atHpOperator")
        ?? activity?.flags?.[MODULE_ID]?.atHpOperator
        ?? "=";
    return [">", "<", "="].includes(raw) ? raw : "=";
}

async function setAtHpOperator(activity, value) {
    const operator = [">", "<", "="].includes(value) ? value : "=";
    if (!activity) return;
    if (typeof activity.setFlag === "function") return activity.setFlag(MODULE_ID, "atHpOperator", operator);
    if (typeof activity.update === "function") return activity.update({ [`flags.${MODULE_ID}.atHpOperator`]: operator });
}

function atHpConditionMet(hp, operator, threshold) {
    hp = Number(hp);
    threshold = Number(threshold);
    if (!Number.isFinite(hp) || !Number.isFinite(threshold)) return false;
    if (operator === ">") return hp > threshold;
    if (operator === "<") return hp < threshold;
    return hp === threshold;
}

function getItemActivities(item) {
    const activities = item?.system?.activities;
    if (!activities) return [];
    if (activities instanceof foundry.utils.Collection) return activities.contents;
    if (activities instanceof Map) return Array.from(activities.values());
    if (Array.isArray(activities)) return activities;
    return Object.values(activities);
}

function getActivityLabel(activity, item) {
    return activity?.name || activity?.label || item?.name || "Activity";
}

function getAtHpSummary(activity) {
    const threshold = getAtHpThreshold(activity);
    const operator = getAtHpOperator(activity);
    return threshold == null ? "At HP" : `At HP ${operator} ${threshold}`;
}

async function createAtHpActivityPrompt(actor, item, activity, hpValue) {
    const activityId = activity.id ?? activity._id;
    const itemId = item.id ?? item._id;
    if (!activityId || !itemId) return;

    const title = getActivityLabel(activity, item);
    const content = `
        <div class="wh-at-hp-prompt">
            <p><strong>${foundry.utils.escapeHTML(actor.name)}</strong> reached <strong>${hpValue} HP</strong>.</p>
            <button type="button" class="wh-at-hp-use" data-actor-uuid="${actor.uuid}" data-item-id="${itemId}" data-activity-id="${activityId}">
                Use ${foundry.utils.escapeHTML(title)}
            </button>
        </div>
    `;

    await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content,
        flags: {
            [MODULE_ID]: {
                atHpPrompt: true,
                actorUuid: actor.uuid,
                itemId,
                activityId,
                hpValue
            }
        }
    });
}

async function checkAtHpActivities(actor, oldHp, newHp) {
    if (!actor || oldHp === newHp || newHp == null) return;

    for (const item of actor.items ?? []) {
        for (const activity of getItemActivities(item)) {
            const activation = getActivityActivation(activity);
            if (activation?.type !== WH_AT_HP_ACTIVATION) continue;

            const threshold = getAtHpThreshold(activity);
            if (threshold == null) continue;
            const operator = getAtHpOperator(activity);
            const wasMet = atHpConditionMet(oldHp, operator, threshold);
            const isMet = atHpConditionMet(newHp, operator, threshold);
            if (isMet && !wasMet) await createAtHpActivityPrompt(actor, item, activity, newHp);
        }
    }
}

function getActivitySheetSelect(root) {
    return root.querySelector(`select[name="activation.type"], select[name="system.activation.type"]`);
}

function normaliseAtHpOptionLabels(root) {
    root?.querySelectorAll?.(`option[value="${WH_AT_HP_ACTIVATION}"]`).forEach(option => {
        option.textContent = "At HP";
        option.label = "At HP";
    });
}

function injectAtHpThresholdField(app, html) {
    if (!isDnd5e()) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;

    normaliseAtHpOptionLabels(root);

    const select = getActivitySheetSelect(root);
    if (!select) return;

    if (![...select.options].some(o => o.value === WH_AT_HP_ACTIVATION)) {
        const option = document.createElement("option");
        option.value = WH_AT_HP_ACTIVATION;
        option.textContent = "At HP";
        option.label = "At HP";
        select.appendChild(option);
    }

    const existingValue = app?.document?.getFlag?.(MODULE_ID, "atHpThreshold")
        ?? app?.document?.flags?.[MODULE_ID]?.atHpThreshold
        ?? "";
    const existingOperator = app?.document?.getFlag?.(MODULE_ID, "atHpOperator")
        ?? app?.document?.flags?.[MODULE_ID]?.atHpOperator
        ?? "=";

    const selectFields = select.closest(".form-fields") ?? select.parentElement;
    if (!selectFields) return;

    const refresh = () => {
        root.querySelectorAll(".wh-at-hp-inline, .wh-at-hp-hint").forEach(el => el.remove());
        normaliseAtHpOptionLabels(root);
        if (select.value !== WH_AT_HP_ACTIVATION) return;

        const inline = document.createElement("label");
        inline.className = "wh-at-hp-inline";
        inline.innerHTML = `
            <span>HP</span>
            <select class="wh-at-hp-operator" aria-label="HP trigger comparison">
                <option value="<" ${existingOperator === "<" ? "selected" : ""}>&lt;</option>
                <option value="=" ${existingOperator === "=" ? "selected" : ""}>=</option>
                <option value=">" ${existingOperator === ">" ? "selected" : ""}>&gt;</option>
            </select>
            <input type="number" step="1" class="wh-at-hp-threshold" value="${foundry.utils.escapeHTML(String(existingValue))}" placeholder="HP">
        `;
        selectFields.appendChild(inline);

        const input = inline.querySelector("input");
        const operator = inline.querySelector("select.wh-at-hp-operator");
        const commitThreshold = async () => {
            await setAtHpThreshold(app?.document, input.value);
        };
        const commitOperator = async () => {
            await setAtHpOperator(app?.document, operator.value);
        };
        input?.addEventListener("change", commitThreshold);
        input?.addEventListener("blur", commitThreshold);
        operator?.addEventListener("change", commitOperator);

        const hint = document.createElement("p");
        hint.className = "hint wh-at-hp-hint";
        hint.textContent = "Prompts this activity when the actor's HP first satisfies this comparison.";
        (select.closest(".form-group") ?? selectFields).insertAdjacentElement("afterend", hint);
    };

    select.addEventListener("change", refresh);
    refresh();
}


function relabelAtHpActivitySections(root) {
    if (!root) return;
    for (const summary of root.querySelectorAll(".wh-at-hp-summary")) {
        const row = summary.closest(".item, li, .directory-item, .items-list .row, .item-row, tr") ?? summary.parentElement;
        const section = row?.closest?.("section, .items-section, .item-section, .activities, .activity-list, .items-list, .tab");
        const heading = section?.querySelector?.(".items-header h3, .items-header h4, .items-header .title, header h3, header h4, h3, h4");
        if (heading && /^\s*Actions\s*$/i.test(heading.textContent ?? "")) heading.textContent = "HP Triggers";
    }
}

function injectAtHpActivitySummaries(app, html) {
    if (!isDnd5e()) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    const actor = app?.document ?? app?.actor;
    if (!root || !actor?.items) return;

    for (const item of actor.items) {
        const atHpActivities = getItemActivities(item).filter(a => getActivityActivation(a)?.type === WH_AT_HP_ACTIVATION);
        if (!atHpActivities.length) continue;

        const summary = foundry.utils.escapeHTML(atHpActivities.map(getAtHpSummary).join(", "));
        const itemId = item.id ?? item._id;
        const row = root.querySelector(`[data-item-id="${itemId}"], [data-document-id="${itemId}"], [data-entry-id="${itemId}"], [data-item-uuid$=".${itemId}"]`);
        if (!row) continue;

        const container = row.closest(".item, li, .directory-item, .items-list .row, .item-row") ?? row;
        container.querySelectorAll(".wh-at-hp-summary").forEach(el => el.remove());

        const title = container.querySelector(".item-name h4, .item-name .name, .item-name .title, .name h4, h4, .title, .name, a") ?? row;
        title.insertAdjacentHTML("afterend", `<div class="wh-at-hp-summary">${summary}</div>`);
    }

    relabelAtHpActivitySections(root);
}

Hooks.once("init", applyAtHpActivationConfig);
Hooks.once("ready", applyAtHpActivationConfig);
Hooks.on("renderActivitySheet", injectAtHpThresholdField);
Hooks.on("renderActivitySheetV2", injectAtHpThresholdField);
Hooks.on("renderItemActivitySheet", injectAtHpThresholdField);
Hooks.on("renderApplicationV2", injectAtHpThresholdField);
Hooks.on("renderActorSheetV2", injectAtHpActivitySummaries);
Hooks.on("renderCharacterActorSheet", injectAtHpActivitySummaries);
Hooks.on("renderApplicationV2", injectAtHpActivitySummaries);

Hooks.on("preUpdateActor", (actor, changes) => {
    if (!foundry.utils.hasProperty(changes, "system.attributes.hp.value")) return;
    WH_PREVIOUS_HP.set(actor.uuid ?? actor.id, getActorHpValue(actor));
});

Hooks.on("updateActor", async (actor, changes) => {
    if (!foundry.utils.hasProperty(changes, "system.attributes.hp.value")) return;
    const key = actor.uuid ?? actor.id;
    const oldHp = WH_PREVIOUS_HP.get(key);
    WH_PREVIOUS_HP.delete(key);
    await checkAtHpActivities(actor, oldHp, getActorHpValue(actor));
});

Hooks.on("renderChatMessage", (message, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    root?.querySelectorAll?.(".wh-at-hp-use").forEach(button => {
        button.addEventListener("click", async event => {
            event.preventDefault();
            const actor = await fromUuid(button.dataset.actorUuid);
            const item = actor?.items?.get(button.dataset.itemId);
            const activity = item?.system?.activities?.get?.(button.dataset.activityId)
                ?? getItemActivities(item).find(a => (a.id ?? a._id) === button.dataset.activityId);

            if (!actor || !item || !activity) {
                return ui.notifications.warn("HP Triggers | Could not find the At HP activity.");
            }

            if (typeof activity.use === "function") return activity.use({ event });
            if (typeof item.use === "function") return item.use({ activity: activity.id ?? activity._id, event });
            ui.notifications.warn("HP Triggers | This D&D5e version does not expose a usable activity method.");
        });
    });
});
