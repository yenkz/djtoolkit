import Button from "../components/Button";

interface WelcomeStepProps {
  onNext: () => void;
}

export default function WelcomeStep({ onNext }: WelcomeStepProps) {
  return (
    <div className="wizard-step welcome-step">
      <div className="welcome-icon">
        <svg width="64" height="64" viewBox="0 0 64 64" fill="none">
          <circle cx="32" cy="32" r="30" stroke="#e94560" strokeWidth="2" fill="none" />
          <circle cx="32" cy="32" r="12" stroke="#e94560" strokeWidth="2" fill="none" />
          <circle cx="32" cy="32" r="3" fill="#e94560" />
          <line x1="32" y1="2" x2="32" y2="14" stroke="#e94560" strokeWidth="2" strokeLinecap="round" />
          <line x1="32" y1="50" x2="32" y2="62" stroke="#e94560" strokeWidth="2" strokeLinecap="round" />
          <line x1="2" y1="32" x2="14" y2="32" stroke="#e94560" strokeWidth="2" strokeLinecap="round" />
          <line x1="50" y1="32" x2="62" y2="32" stroke="#e94560" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>

      <h1 className="welcome-title">djtoolkit</h1>
      <p className="welcome-subtitle">Your DJ library agent</p>
      <p className="welcome-description">
        Download, tag, and organize your music library automatically.
      </p>

      <Button onClick={onNext} className="welcome-cta">
        Get Started
      </Button>
    </div>
  );
}
