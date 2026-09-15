# Command System Flowchart

```mermaid
flowchart TD
    A[Start: handlePrefixCommand: commands.js:625] --> B[Record start time: commands.js:626]
    B --> C[Extract command and args: commands.js:627-633]
    C --> D{Empty command?}
    D -->|Yes| Z[Return early: commands.js:634]
    D -->|No| E{Public command?}
    E -->|Yes| F[Execute public command: commands.js:638-641]
    F --> G[Audit interaction: commands.js:640]
    G --> Z
    E -->|No| H[Load role IDs: commands.js:645]
    H --> I{Moderator command & has perms?}
    I -->|Yes| J[Execute moderator command: commands.js:648-653]
    J --> K[Audit interaction: commands.js:652]
    K --> Z
    I -->|No| L{Administrator command & has perms?}
    L -->|Yes| M[Execute admin command: commands.js:665-670]
    M --> N[Audit interaction: commands.js:669]
    N --> Z
    L -->|No| O[Unknown command audit: commands.js:681-686]
    O --> Z

    subgraph Handle Slash Command [commands.js:689]
        A1[Start: handleSlashCommand: commands.js:689] --> B1[Record start time: commands.js:693]
        B1 --> C1[Extract command name: commands.js:694-695]
        C1 --> D1{In guild & has member?}
        D1 -->|No| E1[Reply invalid context: commands.js:701-706]
        E1 --> F1[Audit interaction: commands.js:704-706]
        F1 --> Z1[End]
        D1 -->|Yes| G1[Load role IDs: commands.js:697-698]
        G1 --> H1{Public command?}
        H1 -->|Yes| I1[Execute public command: commands.js:710-713]
        I1 --> J1[Audit interaction: commands.js:712]
        J1 --> Z1
        H1 -->|No| I2{Moderator command & has perms?}
        I2 -->|Yes| K1[Execute moderator command: commands.js:717-722]
        K1 --> L1[Audit interaction: commands.js:721]
        L1 --> Z1
        I2 -->|No| J2{Administrator command & has perms?}
        J2 -->|Yes| M1[Execute admin command: commands.js:737-742]
        M1 --> N1[Audit interaction: commands.js:741]
        N1 --> Z1
        J2 -->|No| O1[Unknown command reply: commands.js:756-760]
        O1 --> P1[Audit interaction: commands.js:758-760]
        P1 --> Z1
    end

    subgraph Execute Public Command [commands.js:638-641, 710-713]
        EC1[Get command handler: commands.js:639,711] --> EC2{Handler exists?}
        EC2 -->|No| EC3[Return {success: false, errorCode: 'UNKNOWN_COMMAND'}]
        EC2 -->|Yes| EC4[Call handler with args: commands.js:640,712]
        EC4 --> EC5[Return handler result]
    end

    subgraph Execute Moderator Command [commands.js:648-653, 717-722]
        EM1[Get command handler: commands.js:650,719] --> EM2{Handler exists?}
        EM2 -->|No| EM3[Return {success: false, errorCode: 'UNKNOWN_COMMAND'}]
        EM2 -->|Yes| EM4[Call handler with args: commands.js:651,720]
        EM4 --> EM5[Return handler result]
    end

    subgraph Execute Admin Command [commands.js:665-670, 737-742]
        EA1[Get command handler: commands.js:667,739] --> EA2{Handler exists?}
        EA2 -->|No| EA3[Return {success: false, errorCode: 'UNKNOWN_COMMAND'}]
        EA2 -->|Yes| EA4[Call handler with args: commands.js:668,740]
        EA4 --> EA5[Return handler result]
    end
```