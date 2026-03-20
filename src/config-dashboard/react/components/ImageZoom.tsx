/**
 * ImageZoom — wraps an image with hover scale effect and click-to-zoom fullscreen.
 * Uses the existing .app-detail-modal CSS from styles.css for the lightbox.
 */
import React, { useState, useCallback } from 'react';

interface ImageZoomProps {
  src: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function ImageZoom({ src, alt, className, style }: ImageZoomProps) {
  const [showModal, setShowModal] = useState(false);

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowModal(true);
  }, []);

  return (
    <>
      <img
        src={src}
        alt={alt || ''}
        className={className}
        style={{
          ...style,
          cursor: 'zoom-in',
          transition: 'transform 0.15s, box-shadow 0.15s',
        }}
        onClick={handleClick}
        onMouseEnter={e => {
          (e.target as HTMLElement).style.transform = 'scale(1.05)';
          (e.target as HTMLElement).style.boxShadow = '0 4px 20px rgba(139,92,246,0.2)';
        }}
        onMouseLeave={e => {
          (e.target as HTMLElement).style.transform = 'scale(1)';
          (e.target as HTMLElement).style.boxShadow = '';
        }}
      />
      {showModal && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
            cursor: 'pointer',
          }}
          onClick={() => setShowModal(false)}
        >
          <div style={{ position: 'relative', maxWidth: 'calc(100vw - 4rem)', maxHeight: 'calc(100vh - 4rem)' }}>
            <button
              onClick={e => { e.stopPropagation(); setShowModal(false); }}
              style={{
                position: 'absolute', top: -12, right: -12, width: 36, height: 36,
                border: '1px solid rgba(255,255,255,0.15)', borderRadius: '50%',
                background: 'rgba(15,23,42,0.9)', color: '#e2e8f0', fontSize: '1.3rem',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 2, lineHeight: 1,
              }}
            >
              &times;
            </button>
            <img
              src={src}
              alt={alt || ''}
              style={{
                maxWidth: '100%', maxHeight: 'calc(100vh - 6rem)',
                objectFit: 'contain', borderRadius: 8,
                boxShadow: '0 8px 60px rgba(0,0,0,0.5)',
              }}
              onClick={e => e.stopPropagation()}
            />
          </div>
        </div>
      )}
    </>
  );
}
