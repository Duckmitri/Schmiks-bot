const deliveryKeys = [
    'commandExecution',
    'messageEdit',
    'messageDelete',
    'memberJoin',
    'memberLeave',
    'voiceJoin',
    'voiceLeave'
];
const colorKeys = [...deliveryKeys, 'warning', 'mute', 'kick', 'ban'];
const commandPermissions = [
    { name: 'kick', description: 'Kick a member' },
    { name: 'ban', description: 'Ban a member' },
    { name: 'mute', description: 'Mute a member' },
    { name: 'warn', description: 'Warn a member' },
    { name: 'infractions', description: 'View a member\'s infraction history' },
    { name: 'logs', description: 'View server logs' }
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

function getWarningEmbedFormValue() {
    return {
        color: document.getElementById('warningColor').value.toUpperCase(),
        title: document.getElementById('warningTitle').value,
        message: document.getElementById('warningMessage').value
    };
}

function getKickEmbedFormValue() {
    return {
        color: document.getElementById('kickColor').value.toUpperCase(),
        title: document.getElementById('kickTitle').value,
        message: document.getElementById('kickMessage').value
    };
}

function getBanEmbedFormValue() {
    return {
        color: document.getElementById('banColor').value.toUpperCase(),
        title: document.getElementById('banTitle').value,
        message: document.getElementById('banMessage').value
    };
}

function getMuteEmbedFormValue() {
    return {
        color: document.getElementById('muteColor').value.toUpperCase(),
        title: document.getElementById('muteTitle').value,
        message: document.getElementById('muteMessage').value
    };
}

function getAutoRoleFormValue() {
    return {
        autoRole: document.getElementById('autoRole').value
    };
}

function getCommandPermissionsFormValue() {
    return {
        moderatorCommandPermissions: commandPermissions
            .filter(cmd => document.getElementById(`mod-perm-${cmd.name}`).checked)
            .map(cmd => cmd.name),
        adminCommandPermissions: commandPermissions
            .filter(cmd => document.getElementById(`admin-perm-${cmd.name}`).checked)
            .map(cmd => cmd.name)
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
    return document.getElementById(id).value.split(',').filter(Boolean);
}

function generateCommandPermissionCheckboxes() {
    const container = document.getElementById('commandPermissionsContainer');
    container.innerHTML = '';

    // Create moderator checkboxes container
    const modCheckboxesContainer = document.createElement('div');
    modCheckboxesContainer.id = 'moderatorCheckboxesContainer';
    // Create administrator checkboxes container
    const adminCheckboxesContainer = document.createElement('div');
    adminCheckboxesContainer.id = 'adminCheckboxesContainer';

    commandPermissions.forEach(cmd => {
        // Moderator permission checkbox
        const modContainerInner = document.createElement('div');
        modContainerInner.className = 'setting-row';
        modContainerInner.innerHTML = `
            <span>${cmd.description}</span>
            <div class="toggle-color-group">
                <input type="checkbox" id="mod-perm-${cmd.name}" data-cmd-key="${cmd.name}">
            </div>
        `;
        modCheckboxesContainer.appendChild(modContainerInner);

        // Admin permission checkbox
        const adminContainerInner = document.createElement('div');
        adminContainerInner.className = 'setting-row';
        adminContainerInner.innerHTML = `
            <span>${cmd.description}</span>
            <div class="toggle-color-group">
                <input type="checkbox" id="admin-perm-${cmd.name}" data-cmd-key="${cmd.name}">
            </div>
        `;
        adminCheckboxesContainer.appendChild(adminContainerInner);
    });

    container.appendChild(modCheckboxesContainer);
    container.appendChild(adminCheckboxesContainer);

    // By default, show moderator and hide administrator
    adminCheckboxesContainer.style.display = 'none';
}

function updateRoleList(inputId, listId) {
    const input = document.getElementById(inputId);
    const listContainer = document.getElementById(listId);
    const roleIds = input.value.split(',').filter(Boolean);

    listContainer.innerHTML = '';

    roleIds.forEach(roleId => {
        const roleTag = document.createElement('div');
        roleTag.className = 'role-tag';
        roleTag.innerHTML = `
            <span>${roleId.trim()}</span>
            <button class="remove-role" data-role-id="${roleId.trim()}">&times;</button>
        `;
        listContainer.appendChild(roleTag);
    });

    // Add event listeners to remove buttons
    listContainer.querySelectorAll('.remove-role').forEach(button => {
        button.addEventListener('click', () => {
            const roleIdToRemove = button.getAttribute('data-role-id');
            const currentIds = input.value.split(',').filter(id => id.trim() !== roleIdToRemove);
            input.value = currentIds.join(',');
            updateRoleList(inputId, listId);
        });
    });
}

function addRoleToList(roleIdInputId, roleListInputId, listContainerId) {
    const roleIdInput = document.getElementById(roleIdInputId);
    const roleListInput = document.getElementById(roleListInputId);
    const roleId = roleIdInput.value.trim();

    if (roleId) {
        // Check if it's a valid Discord role ID (18-19 digits)
        if (/^\d{17,19}$/.test(roleId)) {
            const currentIds = roleListInput.value.split(',').filter(Boolean);
            if (!currentIds.includes(roleId)) {
                currentIds.push(roleId);
                roleListInput.value = currentIds.join(',');
                updateRoleList(roleListInputId, listContainerId);
                roleIdInput.value = '';
            }
        } else {
            alert('Please enter a valid Discord role ID (17-19 digits)');
        }
    }
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

for (const key of colorKeys) {
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
    const warningEmbed = getWarningEmbedFormValue();
    const kickEmbed = getKickEmbedFormValue();
    const banEmbed = getBanEmbedFormValue();

    const messageDiv = document.getElementById('message');
    messageDiv.style.display = 'none';

    try {
        const response = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prefix, moderatorRoleIds, adminRoleIds, logging, warningEmbed, kickEmbed, banEmbed, muteEmbed: getMuteEmbedFormValue(), autoRole: getAutoRoleFormValue().autoRole, ...getCommandPermissionsFormValue() })
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
            document.getElementById('moderatorRoleIds').value = config.moderatorRoleIds.join(',');
            document.getElementById('adminRoleIds').value = config.adminRoleIds.join(',');
            // Update the role lists display
            updateRoleList('moderatorRoleIds', 'moderatorRolesList');
            updateRoleList('adminRoleIds', 'adminRolesList');
            document.getElementById('loggingChannelId').value = config.logging.channelId;
            document.getElementById('retentionDays').value = config.logging.retentionDays;
            document.getElementById('warningTitle').value = config.warningEmbed.title;
            document.getElementById('warningMessage').value = config.warningEmbed.message;
            document.getElementById('warningColor').value = config.warningEmbed.color;
            syncColorValue('warning');

            document.getElementById('kickTitle').value = config.kickEmbed.title;
            document.getElementById('kickMessage').value = config.kickEmbed.message;
            document.getElementById('kickColor').value = config.kickEmbed.color;
            syncColorValue('kick');

            document.getElementById('banTitle').value = config.banEmbed.title;
            document.getElementById('banMessage').value = config.banEmbed.message;
            document.getElementById('banColor').value = config.banEmbed.color;
            syncColorValue('ban');

            document.getElementById('muteTitle').value = config.muteEmbed.title;
            document.getElementById('muteMessage').value = config.muteEmbed.message;
            document.getElementById('muteColor').value = config.muteEmbed.color;
            syncColorValue('mute');

            document.getElementById('autoRole').value = config.autoRole || '';

            // Load command permissions
            if (config.moderatorCommandPermissions) {
                config.moderatorCommandPermissions.forEach(cmd => {
                    const checkbox = document.getElementById(`mod-perm-${cmd}`);
                    if (checkbox) checkbox.checked = true;
                });
            }
            if (config.adminCommandPermissions) {
                config.adminCommandPermissions.forEach(cmd => {
                    const checkbox = document.getElementById(`admin-perm-${cmd}`);
                    if (checkbox) checkbox.checked = true;
                });
            }

            // Set initial view based on which permissions exist
            const modContainer = document.getElementById('moderatorCheckboxesContainer');
            const adminContainer = document.getElementById('adminCheckboxesContainer');
            const permissionTypeSelect = document.getElementById('permissionTypeSelect');
            if (permissionTypeSelect && modContainer && adminContainer) {
                const hasModPerms = config.moderatorCommandPermissions && config.moderatorCommandPermissions.length > 0;
                const hasAdminPerms = config.adminCommandPermissions && config.adminCommandPermissions.length > 0;

                // If only one type has permissions, show that view; otherwise default to moderator
                if (hasModPerms && !hasAdminPerms) {
                    permissionTypeSelect.value = 'moderator';
                    modContainer.style.display = 'block';
                    adminContainer.style.display = 'none';
                } else if (!hasModPerms && hasAdminPerms) {
                    permissionTypeSelect.value = 'administrator';
                    modContainer.style.display = 'none';
                    adminContainer.style.display = 'block';
                } else {
                    // Default to moderator (existing behavior)
                    permissionTypeSelect.value = 'moderator';
                    modContainer.style.display = 'block';
                    adminContainer.style.display = 'none';
                }
            }

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

// Add event listeners for add role buttons
document.getElementById('addModeratorRole').addEventListener('click', () => {
    addRoleToList('moderatorRoleIdInput', 'moderatorRoleIds', 'moderatorRolesList');
});

document.getElementById('addAdminRole').addEventListener('click', () => {
    addRoleToList('adminRoleIdInput', 'adminRoleIds', 'adminRolesList');
});

// Also allow pressing Enter in the input fields to add the role
document.getElementById('moderatorRoleIdInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        addRoleToList('moderatorRoleIdInput', 'moderatorRoleIds', 'moderatorRolesList');
    }
});

document.getElementById('adminRoleIdInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        addRoleToList('adminRoleIdInput', 'adminRoleIds', 'adminRolesList');
    }
});

// Navigation handling
function setupNavigation() {
  const navLinks = document.querySelectorAll('nav a');
  const sections = document.querySelectorAll('.settings-section');

  // Function to show a section and update active nav link
  function showSection(sectionId) {
    // Hide all sections
    sections.forEach(section => {
      section.style.display = 'none';
    });

    // Remove active class from all nav links
    navLinks.forEach(link => {
      link.classList.remove('active');
    });

    // Show the target section if it exists
    const targetSection = document.getElementById(sectionId);
    if (targetSection) {
      targetSection.style.display = 'block';

      // Add active class to the corresponding nav link
      const activeLink = document.querySelector(`nav a[href="#${sectionId}"]`);
      if (activeLink) {
        activeLink.classList.add('active');
      }
    }
  }

  // Handle nav link clicks
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const sectionId = link.getAttribute('href').substring(1); // Remove '#'
      showSection(sectionId);
      // Update URL hash without scrolling
      history.pushState(null, null, `#${sectionId}`);
    });
  });

  // Show the appropriate section on page load
  window.addEventListener('load', () => {
    const hash = window.location.hash.substring(1); // Remove '#'
    if (hash && document.getElementById(hash)) {
      showSection(hash);
    } else {
      // Default to first section (General)
      const firstSectionId = navLinks[0]?.getAttribute('href')?.substring(1);
      if (firstSectionId) {
        showSection(firstSectionId);
      }
    }
  });

  // Handle back/forward navigation
  window.addEventListener('popstate', () => {
    const hash = window.location.hash.substring(1); // Remove '#'
    if (hash && document.getElementById(hash)) {
      showSection(hash);
    } else {
      // Default to first section (General)
      const firstSectionId = navLinks[0]?.getAttribute('href')?.substring(1);
      if (firstSectionId) {
        showSection(firstSectionId);
      }
    }
  });
}

// Add setupNavigation to be called on load
window.addEventListener('load', () => {
  setupNavigation();
  generateCommandPermissionCheckboxes();
  loadConfig();
  // Add event listener for permission type dropdown
  const permissionTypeSelect = document.getElementById('permissionTypeSelect');
  if (permissionTypeSelect) {
    permissionTypeSelect.addEventListener('change', () => {
      const modContainer = document.getElementById('moderatorCheckboxesContainer');
      const adminContainer = document.getElementById('adminCheckboxesContainer');
      if (permissionTypeSelect.value === 'moderator') {
        modContainer.style.display = 'block';
        adminContainer.style.display = 'none';
      } else {
        modContainer.style.display = 'none';
        adminContainer.style.display = 'block';
      }
    });
  }
});
