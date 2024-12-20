/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./style.css";

import { addPreSendListener, MessageExtra, MessageObject, removePreSendListener } from "@api/MessageEvents";
import { EquicordDevs } from "@utils/constants";
import definePlugin from "@utils/types";
import { Forms } from "@webpack/common";

const handleMessage = (channelID: string, message: MessageObject, messageEx: MessageExtra) => messageEx.uploads && messageEx.uploads.forEach(att => (att as any).isRemix = true);

export default definePlugin({
    name: "RemixMe",
    description: "Turns every single message with attachment to have remix tag",
    authors: [EquicordDevs.kvba],
    settingsAboutComponent: () => <>
        <Forms.FormText className="remixme-warning">
            We can't guarantee this plugin won't get you warned or banned.
        </Forms.FormText>
    </>,
    start: () => addPreSendListener(handleMessage),
    stop: () => removePreSendListener(handleMessage)
});
