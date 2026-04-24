import type { FC } from '../../../lib/teact/teact';
import {
  memo,
  useEffect,
  useState,
} from '../../../lib/teact/teact';

import { IS_BOT_PANEL } from '../../../config';
import {
  addBotPanelBot,
  fetchBotPanelBots,
  getCachedBotPanelMeta,
  getStoredActiveBotId,
  setStoredActiveBotId,
  subscribeBotPanelBots,
} from '../../../api/gramjs/worker/botPanel';

import Button from '../../ui/Button';
import Modal from '../../ui/Modal';

type BotOption = {
  id: number;
  slot?: string;
  label?: string;
  username?: string;
  firstName?: string;
};

function formatBotLabel(bot: BotOption) {
  if (bot.label && bot.username) {
    return `${bot.label} (@${bot.username})`;
  }

  return bot.label || bot.firstName || bot.username || `Bot ${bot.slot || ''}`.trim();
}

const BotPanelSwitcher: FC = () => {
  const initialMeta = getCachedBotPanelMeta();
  const [bots, setBots] = useState<BotOption[]>(initialMeta.bots as BotOption[]);
  const [activeBotId, setActiveBotIdState] = useState(getStoredActiveBotId());
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [newBotToken, setNewBotToken] = useState('');
  const [newBotLabel, setNewBotLabel] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [canAddMore, setCanAddMore] = useState(initialMeta.canAddMore);
  const [maxBots, setMaxBots] = useState(initialMeta.maxBots);

  useEffect(() => {
    if (!IS_BOT_PANEL) {
      return undefined;
    }

    fetchBotPanelBots().then(() => {
      const meta = getCachedBotPanelMeta();
      setBots(meta.bots as BotOption[]);
      setCanAddMore(meta.canAddMore);
      setMaxBots(meta.maxBots);
      setActiveBotIdState(getStoredActiveBotId());
    });

    return subscribeBotPanelBots((payload) => {
      setBots(payload.bots as BotOption[]);
      setCanAddMore(payload.canAddMore);
      setMaxBots(payload.maxBots);
      setActiveBotIdState(getStoredActiveBotId());
    });
  }, []);

  if (!IS_BOT_PANEL || !bots.length) {
    return undefined;
  }

  const handleChange = (event: any) => {
    const nextBotId = event.currentTarget.value;
    if (!nextBotId || nextBotId === activeBotId) {
      return;
    }

    setStoredActiveBotId(nextBotId);
    setActiveBotIdState(nextBotId);
    window.location.replace(`${window.location.pathname}${window.location.search}`);
  };

  const handleOpenAddModal = () => {
    setSubmitError(undefined);
    setNewBotToken('');
    setNewBotLabel('');
    setIsAddModalOpen(true);
  };

  const handleCloseAddModal = () => {
    if (isSubmitting) {
      return;
    }

    setIsAddModalOpen(false);
    setSubmitError(undefined);
  };

  const handleSubmit = async () => {
    const token = newBotToken.trim();
    const label = newBotLabel.trim();

    if (!token) {
      setSubmitError('Bot token is required');
      return;
    }

    setIsSubmitting(true);
    setSubmitError(undefined);

    try {
      const bot = await addBotPanelBot({ token, label });
      if (bot?.id) {
        setStoredActiveBotId(String(bot.id));
      }

      setIsAddModalOpen(false);
      window.location.replace(`${window.location.pathname}${window.location.search}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to connect bot');
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div className="BotPanelSwitcher">
        <select
          className="BotPanelSwitcher-select"
          value={activeBotId || String(bots[0].id)}
          onChange={handleChange}
          aria-label="Select bot"
          title="Switch bot"
        >
          {bots.map((bot) => (
            <option key={bot.id} value={String(bot.id)}>
              {formatBotLabel(bot)}
            </option>
          ))}
        </select>
        <Button
          className="BotPanelSwitcher-add"
          round
          size="smaller"
          color="translucent"
          ariaLabel={canAddMore ? 'Add bot' : `Bot limit reached (${bots.length}/${maxBots})`}
          disabled={!canAddMore}
          onClick={handleOpenAddModal}
        >
          +
        </Button>
      </div>
      <Modal
        className="BotPanelSwitcherModal slim"
        title="Add Bot"
        isOpen={isAddModalOpen}
        hasCloseButton
        onClose={handleCloseAddModal}
        onEnter={handleSubmit}
      >
        <div className="BotPanelSwitcherModal-fields">
          <div className="input-group with-label touched">
            <input
              className="form-control"
              type="password"
              autoComplete="off"
              value={newBotToken}
              onInput={(event: any) => setNewBotToken(event.currentTarget.value)}
              aria-label="Bot token"
              placeholder="123456:ABC..."
            />
            <label>Bot token</label>
          </div>
          <div className="input-group with-label touched">
            <input
              className="form-control"
              type="text"
              autoComplete="off"
              value={newBotLabel}
              onInput={(event: any) => setNewBotLabel(event.currentTarget.value)}
              aria-label="Label"
              placeholder="Support Bot"
            />
            <label>Label (optional)</label>
          </div>
          <div className="BotPanelSwitcherModal-help">
            Up to {maxBots} bots. New bots connect immediately and keep saving messages in background.
          </div>
          {submitError && (
            <div className="BotPanelSwitcherModal-error">
              {submitError}
            </div>
          )}
        </div>
        <div className="dialog-buttons mt-2">
          <Button isText inline disabled={isSubmitting} onClick={handleSubmit}>
            {isSubmitting ? 'Connecting...' : 'Add Bot'}
          </Button>
          <Button isText onClick={handleCloseAddModal}>
            Cancel
          </Button>
        </div>
      </Modal>
    </>
  );
};

export default memo(BotPanelSwitcher);
