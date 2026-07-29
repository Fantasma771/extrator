FROM mcr.microsoft.com/playwright/python:v1.45.0-jammy
WORKDIR /app
COPY requirements.txt app.py ./
RUN pip install --no-cache-dir -r requirements.txt
EXPOSE 10000
CMD ["python", "app.py"]
