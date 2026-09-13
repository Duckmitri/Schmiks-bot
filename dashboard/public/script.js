const deliveryKeys = [
    'commandExecution',
    'messageEdit',
    'messageDelete',
    'memberJoin',
    'memberLeave',
    'voiceJoin',
    'voiceLeave'
];

function getLoggingFormValue() {
    const delivery = Object.fromEntries(deliveryKeys.map(key => [
        key,
        document.querySelector(`[data-delivery-key="${key}"]`).checked
    ]));
    const colors = Object.fromEntries(deliveryKeys.map(key => [
        key,
        document.querySelector(`[data-color-key="${key}"]`).value.toUpperCase()
    ]));

    return {
        channelId: document.getElementById('loggingChannelId').value,
        retentionDays: Number(document.getElementById('retentionDays').value),
        colors,
        delivery
    };
}

function syncColorValue(key) {
    const input = document.querySelector(`[data-color-key="${key}"]`);
    const value = input.value.toUpperCase();
    document.querySelector(`[data-color-value="${key}"]`).textContent = value;
    document.querySelector(`[data-color-trigger="${key}"] .color-swatch`)
        .style.setProperty('--swatch', value);
}

function getRoleIds(id) {
    return document.getElementById(id).value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
}

const colorPopover = document.getElementById('colorPopover');
const colorHexInput = document.getElementById('colorHexInput');
const colorChannels = Object.fromEntries([...document.querySelectorAll('[data-color-channel]')]
    .map(input => [input.dataset.colorChannel, input]));
const colorNumbers = Object.fromEntries([...document.querySelectorAll('[data-color-number]')]
    .map(input => [input.dataset.colorNumber, input]));
let activeColorKey;
let originalColor;

function setPickerColor(value) {
    const color = parseHexColor(value);
    if (!color) return false;
    const hex = formatHexColor(color);
    colorHexInput.value = hex;
    colorPopover.style.setProperty('--picker-color', hex);
    for (const [channel, input] of Object.entries(colorChannels)) {
        input.value = color[channel];
        colorNumbers[channel].value = color[channel];
        document.querySelector(`[data-channel-value="${channel}"]`).textContent = color[channel];
    }
    return true;
}

function openColorPicker(key, trigger) {
    activeColorKey = key;
    originalColor = document.querySelector(`[data-color-key="${key}"]`).value;
    document.getElementById('colorPopoverTitle').textContent = trigger.closest('.setting-row')
        .querySelector(':scope > span').textContent;
    setPickerColor(originalColor);
    colorPopover.showPopover();

    const triggerRect = trigger.getBoundingClientRect();
    const pickerRect = colorPopover.getBoundingClientRect();
    const left = Math.min(window.innerWidth - pickerRect.width - 12, Math.max(12, triggerRect.right - pickerRect.width));
    const roomBelow = triggerRect.bottom + pickerRect.height + 8 <= window.innerHeight;
    const top = roomBelow ? triggerRect.bottom + 8 : Math.max(12, triggerRect.top - pickerRect.height - 8);
    colorPopover.style.left = `${left}px`;
    colorPopover.style.top = `${top}px`;
    colorHexInput.focus();
    colorHexInput.select();
}

for (const key of deliveryKeys) {
    const trigger = document.querySelector(`[data-color-trigger="${key}"]`);
    trigger.addEventListener('click', () => openColorPicker(key, trigger));
}

for (const input of Object.values(colorChannels)) {
    input.addEventListener('input', () => setPickerColor(formatHexColor({
        red: colorChannels.red.value,
        green: colorChannels.green.value,
        blue: colorChannels.blue.value
    })));
}

colorHexInput.addEventListener('input', () => setPickerColor(colorHexInput.value));
for (const input of Object.values(colorNumbers)) {
    input.addEventListener('input', () => {
        const color = normalizeRgbColor(Object.fromEntries(Object.entries(colorNumbers)
            .map(([channel, numberInput]) => [channel, numberInput.value])));
    if (color) setPickerColor(formatHexColor(color));
    });
}
document.querySelector('[data-color-reset]').addEventListener('click', () => setPickerColor(originalColor));
document.querySelector('[data-color-close]').addEventListener('click', () => colorPopover.hidePopover());
document.querySelector('[data-color-done]').addEventListener('click', () => {
    if (!activeColorKey || !setPickerColor(colorHexInput.value)) return;
    document.querySelector(`[data-color-key="${activeColorKey}"]`).value = colorHexInput.value;
    syncColorValue(activeColorKey);
    colorPopover.hidePopover();
});

document.getElementById('configForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const prefix = document.getElementById('prefix').value;
    const moderatorRoleIds = getRoleIds('moderatorRoleIds');
    const adminRoleIds = getRoleIds('adminRoleIds');
    const logging = getLoggingFormValue();

    const messageDiv = document.getElementById('message');
    messageDiv.style.display = 'none';

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prefix, moderatorRoleIds, adminRoleIds, logging })
        });

        const data = await response.json();

        if (response.ok) {
            messageDiv.className = 'message success';
            messageDiv.textContent = data.message || 'Configuration saved successfully!';
        } else {
            messageDiv.className = 'message error';
            messageDiv.textContent = data.error || 'An error occurred';
        }
    } catch (err) {
        messageDiv.className = 'message error';
        messageDiv.textContent = 'Network error: ' + err.message;
    }

    messageDiv.style.display = 'block';
});

// Load existing config on page load
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        if (response.ok) {
            const config = await response.json();
            document.getElementById('prefix').value = config.prefix || '';
            document.getElementById('moderatorRoleIds').value = config.moderatorRoleIds.join('\n');
            document.getElementById('adminRoleIds').value = config.adminRoleIds.join('\n');
            document.getElementById('loggingChannelId').value = config.logging.channelId;
            document.getElementById('retentionDays').value = config.logging.retentionDays;
            for (const key of deliveryKeys) {
                document.querySelector(`[data-delivery-key="${key}"]`).checked = config.logging.delivery[key];
                document.querySelector(`[data-color-key="${key}"]`).value = config.logging.colors[key];
                syncColorValue(key);
            }
        }
    } catch (err) {
        console.error('Failed to load config:', err);
    }
}

window.addEventListener('load', loadConfig);
