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
    document.querySelector(`[data-color-value="${key}"]`).textContent = input.value.toUpperCase();
}

for (const key of deliveryKeys) {
    document.querySelector(`[data-color-key="${key}"]`).addEventListener('input', () => syncColorValue(key));
}

document.getElementById('configForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const prefix = document.getElementById('prefix').value;
    const logging = getLoggingFormValue();

    const messageDiv = document.getElementById('message');
    messageDiv.style.display = 'none';

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prefix, logging })
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
