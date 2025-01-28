// client.js
const chatLog = document.getElementById('chatLog');
const queryInput = document.getElementById('queryInput');
const sendBtn = document.getElementById('sendBtn');
const spinner = document.getElementById('spinner');

// 1) Open an SSE connection to /sse
const eventSource = new EventSource('/sse');

// 2) When a message arrives, parse and display
eventSource.onmessage = (event) => {
    let data;
    try {
        data = JSON.parse(event.data);
    } catch (err) {
        console.warn('Could not parse SSE event data:', event.data);
        return;
    }
    // data should be { role, content }
    appendMessage(data.role, data.content);
};

eventSource.onerror = (err) => {
    console.error('SSE error:', err);
    appendMessage('internal', `SSE error: ${err.message}`);
};

// Keep a local array only for display, not used for LLM context
const messages = [];

/**
 * Display a message bubble in the chat
 */
function appendMessage(role, content) {
    messages.push({ role, content });

    const row = document.createElement('div');
    row.className = 'message-row';

    if (role === 'user') {
        row.classList.add('user-message');
    } else if (role === 'assistant') {
        row.classList.add('assistant-message');
    } else {
        row.classList.add('internal-message');
    }

    const bubble = document.createElement('div');
    bubble.className = `bubble ${role}`;
    bubble.textContent = content;
    row.appendChild(bubble);
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
}

/**
 * Send the user's query to the server with POST /message
 */
async function sendQuery(query) {
    spinner.style.display = 'inline-block';
    appendMessage('user', query);

    try {
        const resp = await fetch('/message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
        });
        const data = await resp.json();
        if (data.error) {
            appendMessage('internal', `Server error: ${data.error}`);
        }
    } catch (err) {
        appendMessage('internal', `Network error: ${err.message}`);
    } finally {
        spinner.style.display = 'none';
    }
}

/** EVENT HANDLERS * */

sendBtn.addEventListener('click', () => {
    const query = queryInput.value.trim();
    if (query) {
        sendQuery(query);
        queryInput.value = '';
    }
});

queryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        sendBtn.click();
    }
});
